#!/usr/bin/env bash
# Live Audio Stream Service Script
source /etc/birdnet/birdnet.conf

# Fork-local (see CLAUDE.md): the livestream follows LIVESTREAM_SOURCE, defaulting to the
# LOCAL MIC even when RTSP_STREAM is set. Upstream unconditionally prefers RTSP, which meant
# that configuring the Xiaomi camera for detection silently began broadcasting the camera's
# microphone with no separate opt-in. Set LIVESTREAM_SOURCE=rtsp in birdnet.conf to stream
# the camera instead.
# Fork-local (2026-09-04): both ffmpeg encoders take -use_wallclock_as_timestamps 1 and the
# trailing -re is gone. The ALSA demuxer's own timestamps jitter backwards on the shared
# dsnoop capture device, so the mp3 muxer logged "non monotonically increasing dts" ~30x a
# minute (31 in a 40s sample; 0 with wallclock stamps) and grew the journal to ~390MB. The
# -re sat after the output URL, where ffmpeg reports it as a trailing option and ignores it;
# it would also be wrong for a live input, which is already real time.
# Fork-local (2026-09-04): the encoder pushes to the fork-owned Icecast instance
# (icecast2-avian.service, 127.0.0.1:8002), not the stock icecast2 on 8000. Upstream's
# "Require password on local network" policy stops the stock unit, blocks it from starting
# and answers /stream with 404 - which took the live stream down with it. The fork instance
# sits outside that policy, and the Caddy site overlay's /stream route proxies to it with
# the same LAN-only header checks upstream uses. Override the port in birdnet.conf if needed.
LIVESTREAM_ICECAST_PORT="${LIVESTREAM_ICECAST_PORT:-8002}"

livestream_uses_rtsp() {
  [ "${LIVESTREAM_SOURCE:-mic}" = 'rtsp' ] && [ -n "${RTSP_STREAM:-}" ]
}

if [ "${1:-}" = '--check' ] && [ "$#" -eq 1 ]; then
  if ! livestream_uses_rtsp; then
    case "${REC_CARD:-}" in
      hw:*|plughw:*) exit 1 ;;
    esac
  fi
  exit 0
elif [ "$#" -ne 0 ]; then
  echo 'Usage: livestream.sh [--check]' >&2
  exit 64
fi

ensure_pulseaudio() {
  if ! pulseaudio --check; then
    pulseaudio --start
  fi
}

# Read the logging level from the configuration option
LOGGING_LEVEL="${LogLevel_LiveAudioStreamService}"
# If empty for some reason default to log level of error
[ -z $LOGGING_LEVEL ] && LOGGING_LEVEL='error'
# Additionally if we're at debug or info level then allow printing of script commands and variables
if [ "$LOGGING_LEVEL" == "info" ] || [ "$LOGGING_LEVEL" == "debug" ];then
  # Enable printing of commands/variables etc to terminal for debugging
  set -x
fi

FREQSHIFT_OPT=''
if [ "$ACTIVATE_FREQSHIFT_IN_LIVESTREAM" == "true" ]; then
  FREQSHIFT_OPT='-af rubberband=pitch='${FREQSHIFT_LO}'/'${FREQSHIFT_HI}
fi

if livestream_uses_rtsp;then
  # Explode the RSPT steam setting into an array so we can count the number we have
  RSTP_STREAMS_EXPLODED_ARRAY=(${RTSP_STREAM//,/ })

  # If for some reason the RTSP_STREAM_TO_LIVESTREAM is not set, then init it to 0 to use the first stream
  if [[ -z ${RTSP_STREAM_TO_LIVESTREAM} ]];then
    RTSP_STREAM_TO_LIVESTREAM=0
  fi

  # Get the RSTP stream at the specified array index
  SELECTED_RSTP_STREAM=${RSTP_STREAMS_EXPLODED_ARRAY[RTSP_STREAM_TO_LIVESTREAM]}

  # If for some reason the RTSP stream url is null
  if [[ -z ${SELECTED_RSTP_STREAM} ]];then
    # Try select the first stream
    SELECTED_RSTP_STREAM=${RSTP_STREAMS_EXPLODED_ARRAY[0]}
  fi

  ffmpeg -nostdin -loglevel $LOGGING_LEVEL -ac ${CHANNELS} -use_wallclock_as_timestamps 1 -i ${SELECTED_RSTP_STREAM} -acodec libmp3lame \
    -b:a 320k -ac ${CHANNELS} -content_type 'audio/mpeg' \
    ${FREQSHIFT_OPT} \
    -f mp3 icecast://source:${ICE_PWD}@localhost:${LIVESTREAM_ICECAST_PORT}/stream
else
  case "${REC_CARD:-}" in
    hw:*|plughw:*)
      echo "Live stream disabled: ${REC_CARD} is reserved for bird recording"
      exit 0
      ;;
    ''|default|pulse)
      ensure_pulseaudio
      ;;
  esac
  CAPTURE_DEVICE=${REC_CARD:-default}
  ffmpeg -nostdin -loglevel $LOGGING_LEVEL -ac ${CHANNELS} -f alsa -use_wallclock_as_timestamps 1 -i "${CAPTURE_DEVICE}" -acodec libmp3lame \
    -b:a 320k -ac ${CHANNELS} -content_type 'audio/mpeg' \
    ${FREQSHIFT_OPT} \
    -f mp3 icecast://source:${ICE_PWD}@localhost:${LIVESTREAM_ICECAST_PORT}/stream
fi
