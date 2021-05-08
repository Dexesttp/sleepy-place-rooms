const url = require('url');
const HTTPServer = require('http');
const WebSocket = require('ws');

const webpage = `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Sleepy place room</title>
  </head>
  <body>
    <input id="input" type="text">
    <button id="send">Send</button>
    <div id="output"></div>
    <script type="application/javascript">
      var input = document.getElementById('input');
      var output = document.getElementById('output');
      var send = document.getElementById('send');

      function addMessage(message) {
          const p = document.createElement('p');
          p.innerHTML = message;
          output.appendChild(p);
      }

      var websocket_url = 'ws://' + window.location.host + '/websocket';
      var websocket = new WebSocket(websocket_url);
      websocket.onopen = () => { addMessage('Connected!'); };
      websocket.onmessage = (event) => { addMessage('[Received] ' + event.data); };
      websocket.onerror = (event) => { addMessage('[Error] ' + event.data); };
      websocket.onclose = () => { addMessage('Closed!'); };
      send.onclick = () => {
        addMessage('[Sent] ' + input.value);
        websocket.send(input.value);
        input.value = '';
      };
    </script>
  </body>
</html>
`;

const server = HTTPServer.createServer((request, response) => {
  console.log(`Request received: ${request.url}`);
  response.writeHead(200);
  response.write(webpage);
  response.end();
});
const websocket = new WebSocket.Server({ noServer: true });
websocket.on('connection', function connection(ws) {
  ws.on('open', () => {
    console.log(`Client connected : ${ws.url}`);
  });

  ws.on('message', (data) => {
    ws.send(data);
  });

  ws.on('close', () => {
    console.log(`Client disconnected : ${ws.url}`);
  });
});

server.on('upgrade', (request, socket, head) => {
  if (request.url === '/websocket') {
    websocket.handleUpgrade(request, socket, head, function done(ws) {
      websocket.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});
server.on('listening', () => {
  console.log(`Server started at http://localhost:18029/`);
});

server.listen(18029, 'localhost');
