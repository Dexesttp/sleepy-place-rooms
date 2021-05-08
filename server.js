const fs = require('fs');
const HTTPServer = require('http');
const WebSocket = require('ws');

let index_webpage = fs.readFileSync('static/index.html');
fs.watchFile('static/index.html', { interval: 1000 }, () => {
  console.log('Reloaded index.html');
  index_webpage = fs.readFileSync('static/index.html');
});

let room_webpage = fs.readFileSync('static/room.html');
fs.watchFile('static/room.html', { interval: 1000 }, () => {
  console.log('Reloaded room.html');
  room_webpage = fs.readFileSync('static/room.html');
});

const rooms = {};

const base_room_url_regex = /^\/room\/(\w+)$/;
const room_websocket_url_regex = /^\/room\/(\w+)\/websocket$/;

const server = HTTPServer.createServer((request, response) => {
  const base_room_url_result = base_room_url_regex.exec(request.url);
  if (base_room_url_result) {
    const room_name = base_room_url_result[1];
    console.log(`Request received: ${request.url}. Showing room ${room_name}.`);
    response.writeHead(200);
    response.write(room_webpage);
    response.end();
    return;
  }
  console.log(`Request received: ${request.url}. Showing index.`);
  response.writeHead(200);
  response.write(index_webpage);
  response.end();
  return;
});

const websocket = new WebSocket.Server({ noServer: true });
websocket.on('connection', (ws, socket) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  const room_websocket_url_result = room_websocket_url_regex.exec(socket.url);
  if (!room_websocket_url_result) {
    console.log(`WS Client rejected from url : ${ws.url}`);
    ws.close();
    return;
  }
  const room_name = room_websocket_url_result[1];
  if (!rooms[room_name]) {
    rooms[room_name] = {
      name: room_name,
      users: [],
      connections: [],
    };
  }
  const room_data = rooms[room_name];
  let username = null;

  console.log(`WS Client connected to room : ${room_name}`);
  ws.on('message', (raw_data) => {
    const data = JSON.parse(raw_data);
    if (data.type == 'user_login') {
      if (username) return;
      if (room_data.users.indexOf(data.username) >= 0) {
        console.log(
          `WS Client username ${data.username} already taken in room : ${room_name}`
        );
        ws.send(
          JSON.stringify({ type: 'username_taken', username: data.username })
        );
        ws.close();
        return;
      }
      username = data.username;
      room_data.users.push(username);
      room_data.connections.push(ws);
      console.log(`WS Client ${username} registered in room : ${room_name}`);
      for (const connection of room_data.connections) {
        connection.send(
          JSON.stringify({ type: 'user_list', users: room_data.users })
        );
      }
      return;
    }

    if (!username) return;
    if (data.type === 'message') {
      if (data.username != username) return;
      console.log(
        `WS Client ${data.username} sent message ${data.message} in room : ${room_name}`
      );
      for (const connection of room_data.connections) {
        connection.send(
          JSON.stringify({
            type: 'message',
            username: data.username,
            message: data.message,
          })
        );
      }
    }
  });
  ws.on('close', () => {
    console.log(`WS Client ${username} disconnected from room : ${room_name}`);
    if (!username) return;
    room_data.connections = room_data.connections.filter((c) => c != ws);
    room_data.users = room_data.users.filter((u) => u != username);
    for (const connection of room_data.connections) {
      connection.send(
        JSON.stringify({ type: 'user_list', users: room_data.users })
      );
    }
  });
});

setInterval(() => {
  websocket.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.on('upgrade', (request, socket, head) => {
  if (room_websocket_url_regex.test(request.url)) {
    websocket.handleUpgrade(request, socket, head, (ws) => {
      websocket.emit('connection', ws, request);
    });
    return;
  }

  socket.destroy();
});

server.on('listening', () => {
  console.log(`Server started at http://localhost:18029/room/`);
});

server.listen(18029, 'localhost');
