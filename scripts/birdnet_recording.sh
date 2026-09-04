#!/usr/bin/env bash
# Performs the recording from the specified RTSP stream or soundcard
source /etc/birdnet/birdnet.conf

# -use_wallclock_as_timestamps is a fork-local change (see CLAUDE.md). When the upstream
# producer (go2rtc) drops and re-establishes the camera link, the source timestamps restart
# or jump backwards; the segment muxer then never reaches its next boundary again and keeps
# appending to one WAV forever. That file never closes, so birdnet_analysis (inotify
# close-watch) never sees it, and it grows at ~660MB/hour. Deriving PTS from the wall clock
# keeps them monotonic across a reconnect so boundaries keep firing.
loop_ffmpeg(){
  while true;do
    if ! ffmpeg -hide_banner -loglevel $LOGGING_LEVEL -nostdin ${1} -use_wallclock_as_timestamps 1 -i ${2} -vn -map a:0 -acodec pcm_s16le -ac 2 -ar 48000 -f segment -segment_format wav -segment_time ${RECORDING_LENGTH} -reset_timestamps 1 -strftime 1 ${RECS_DIR}/StreamData/%F-birdnet-RTSP_${3}-%H:%M:%S.wav
    then
      sleep 1
    fi
  done
}

# Fork-local watchdog (see CLAUDE.md). Belt-and-braces behind the timestamp fix above, for
# the two ways the RTSP capture can die *silently* - the service stays active, the local mic
# keeps working, and only the camera half stops:
#   1. the segment muxer stalls and one WAV grows without bound;
#   2. ffmpeg stays alive but stops emitting segments altogether.
# Either way only this stream's ffmpeg is killed; loop_ffmpeg's own retry restarts it, so the
# local mic is never interrupted (unlike restarting the whole service).
watchdog_ffmpeg(){
  local n="$1"
  local pat="birdnet-RTSP_${n}-"
  # One healthy segment is RECORDING_LENGTH * 48000 * 2ch * 2bytes; trip at 4x that.
  local max_bytes=$(( RECORDING_LENGTH * 192000 * 4 ))
  local stall_secs=$(( RECORDING_LENGTH * 5 ))
  [ "$stall_secs" -lt 90 ] && stall_secs=90
  local last_name="" last_new=$SECONDS newest big pid killed
  while true; do
    sleep "$RECORDING_LENGTH"
    killed=""

    newest=$(ls -1 "${RECS_DIR}/StreamData/" 2>/dev/null | grep -F "$pat" | sort | tail -1)
    if [ -n "$newest" ] && [ "$newest" != "$last_name" ]; then
      last_name="$newest"
      last_new=$SECONDS
    fi

    # Unlink an oversized segment BEFORE killing ffmpeg. ffmpeg keeps writing to the now
    # unlinked inode and the blocks are freed when it exits, so the analyser is never handed
    # a ~500MB WAV to load on a 1GB Pi.
    big=$(find "${RECS_DIR}/StreamData" -maxdepth 1 -name "*${pat}*.wav" -size +${max_bytes}c 2>/dev/null | head -1)
    if [ -n "$big" ]; then
      echo "watchdog: RTSP_${n} segmentation stalled ($(basename "$big") exceeded ${max_bytes} bytes); restarting ffmpeg" >&2
      rm -f "$big"
      killed=yes
    elif [ $(( SECONDS - last_new )) -ge "$stall_secs" ]; then
      if pgrep -f "$pat" >/dev/null 2>&1; then
        echo "watchdog: no new RTSP_${n} segment in ${stall_secs}s; restarting ffmpeg" >&2
        killed=yes
      fi
      last_new=$SECONDS
    fi

    if [ -n "$killed" ]; then
      for pid in $(pgrep -f "$pat" 2>/dev/null); do
        [ "$pid" = "$$" ] && continue
        [ "$pid" = "$BASHPID" ] && continue
        kill "$pid" 2>/dev/null
      done
      last_new=$SECONDS
      last_name=""
    fi
  done
}

ensure_pulseaudio() {
  if ! pulseaudio --check; then
    pulseaudio --start
  fi
}

loop_arecord(){
  case "${REC_CARD:-}" in
    ''|default|pulse) ensure_pulseaudio ;;
  esac
  if pgrep arecord &> /dev/null ;then
    echo "Recording"
  else
    if [ -z "${REC_CARD:-}" ];then
      arecord -f S16_LE -c${CHANNELS} -r48000 -t wav --max-file-time ${RECORDING_LENGTH}\
        --use-strftime ${RECS_DIR}/StreamData/%F-birdnet-%H:%M:%S.wav
    else
      arecord -f S16_LE -c${CHANNELS} -r48000 -t wav --max-file-time ${RECORDING_LENGTH}\
        -D "${REC_CARD}" --use-strftime ${RECS_DIR}/StreamData/%F-birdnet-%H:%M:%S.wav
    fi
  fi
}

# Read the logging level from the configuration option
LOGGING_LEVEL="${LogLevel_BirdnetRecordingService}"
# If empty for some reason default to log level of error
[ -z $LOGGING_LEVEL ] && LOGGING_LEVEL='error'
# Additionally if we're at debug or info level then allow printing of script commands and variables
if [ "$LOGGING_LEVEL" == "info" ] || [ "$LOGGING_LEVEL" == "debug" ];then
  # Enable printing of commands/variables etc to terminal for debugging
  set -x
fi

[ -z $RECORDING_LENGTH ] && RECORDING_LENGTH=15
[ -d $RECS_DIR/StreamData ] || mkdir -p $RECS_DIR/StreamData

# Local mic and RTSP stream(s) are recorded concurrently (fork-local change - upstream
# treats these as mutually exclusive; see CLAUDE.md).
loop_arecord &

if [ -n "${RTSP_STREAM}" ];then
  # Explode the RTSP steam setting into an array so we can count the number we have
  RTSP_STREAMS_EXPLODED_ARRAY=(${RTSP_STREAM//,/ })
  FFMPEG_VERSION=$(ffmpeg -version | head -n 1 | cut -d ' ' -f 3 | cut -d '.' -f 1)

  STREAM_COUNT=1
  # Loop over the streams
  for i in "${RTSP_STREAMS_EXPLODED_ARRAY[@]}"
  do
    if [[ "$i" =~ ^rtsps?:// ]]; then
      [ $FFMPEG_VERSION -lt 5 ] && PARAM=-stimeout || PARAM=-timeout
      TIMEOUT_PARAM="$PARAM 10000000"
    elif [[ "$i" =~ ^[a-z]+:// ]]; then
      TIMEOUT_PARAM="-rw_timeout 10000000"
    else
      TIMEOUT_PARAM=""
    fi
    loop_ffmpeg "${TIMEOUT_PARAM}" "${i}" "${STREAM_COUNT}" &
    watchdog_ffmpeg "${STREAM_COUNT}" &
    ((STREAM_COUNT += 1))
  done
fi

wait
