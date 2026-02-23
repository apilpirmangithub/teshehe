#!/bin/bash
PORT=3000
PID=$(ss -tlpn | grep ":$PORT" | grep -o "pid=[0-9]*" | cut -d= -f2)
if [ -n "$PID" ]; then
  echo "Killing process $PID on port $PORT"
  kill -9 $PID
else
  echo "Port $PORT is clear"
fi
