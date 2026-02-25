#!/bin/bash

# Requires curl, jq and wscat
# To run locally, ensure npm install -g wscat

echo "Waiting for backend..."
sleep 2

echo "Creating a new document via REST API..."
RESPONSE=$(curl -s -X POST http://localhost:3000/api/documents \
  -H "Content-Type: application/json" \
  -d '{"title":"OT Test","content":"Initial "}')

DOC_ID=$(echo $RESPONSE | jq -r '.id')
VERSION=$(echo $RESPONSE | jq -r '.version')

echo "Document created with ID: $DOC_ID, Version: $VERSION"

echo "Simulating Client 1 joining and inserting..."
echo '{"type": "JOIN", "docId": "'$DOC_ID'", "userId": "user1"}
{"type": "OPERATION", "docId": "'$DOC_ID'", "version": 0, "operation": {"type": "insert", "position": 8, "chars": "A"}}' > client1_cmds.txt

echo "Simulating Client 2 joining and inserting..."
echo '{"type": "JOIN", "docId": "'$DOC_ID'", "userId": "user2"}
{"type": "OPERATION", "docId": "'$DOC_ID'", "version": 0, "operation": {"type": "insert", "position": 8, "chars": "B"}}' > client2_cmds.txt

echo "Running concurrent wscat clients..."
# Run wscat clients in background
cat client1_cmds.txt | wscat -c ws://localhost:3000/ws &
PID1=$!

cat client2_cmds.txt | wscat -c ws://localhost:3000/ws &
PID2=$!

sleep 3
# Kill wscat Background processes as they may stay open
kill $PID1 2>/dev/null
kill $PID2 2>/dev/null

echo "Fetching final document state..."
curl -s http://localhost:3000/api/documents/$DOC_ID | jq .
