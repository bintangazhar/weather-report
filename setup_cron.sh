#!/usr/bin/env bash
# Setup cron job for weather monitor

SCRIPT_DIR="/home/bintang/scripts/weather-pontianak"
PYTHON="$SCRIPT_DIR/venv/bin/python"
SCRIPT="$SCRIPT_DIR/weather_monitor.py"
LOG="$SCRIPT_DIR/cron.log"

# Cron entry: run every hour at minute 5 (avoid top of hour API spikes)
CRON_ENTRY="*/30 * * * * cd $SCRIPT_DIR && $PYTHON $SCRIPT >> $LOG 2>&1"

echo "Adding cron job..."
echo "$CRON_ENTRY" | crontab -

echo "Current crontab:"
crontab -l

echo ""
echo "To remove: crontab -r"
echo "To view logs: tail -f $SCRIPT_DIR/cron.log"
echo "To test manually: cd $SCRIPT_DIR && source venv/bin/activate && python weather_monitor.py"
