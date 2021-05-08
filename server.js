const fs = require('fs');
const HTTPServer = require('http');
const WebSocket = require('ws');

let index_webpage = fs.readFileSync('static/index.html');
fs.watchFile('static/index.html', { interval: 1000 }, () => {
  console.log('Reloaded index.html');
  index_webpage = fs.readFileSync('static/index.html');
});

let display_webpage = fs.readFileSync('static/display.html');
fs.watchFile('static/display.html', { interval: 1000 }, () => {
  console.log('Reloaded display.html');
  display_webpage = fs.readFileSync('static/display.html');
});

let control_webpage = fs.readFileSync('static/control.html');
fs.watchFile('static/control.html', { interval: 1000 }, () => {
  console.log('Reloaded control.html');
  control_webpage = fs.readFileSync('static/control.html');
});

/** @type {{
  [key: string]: {
    name: room_name,
    users: { username: string, mode: 'display' | 'control' }[],
    connections: WebSocket[],
    is_control_locked: boolean,
    is_all_locked: boolean,
  }
}} */
const rooms = {};

const valid_username_regex = /^[\w ()]+$/;
const base_room_url_regex = /^\/room\/(\w{1,64})\/?$/;
const control_room_url_regex = /^\/room\/(\w{1,64})\/control$/;
const room_websocket_url_regex = /^\/room\/(\w{1,64})\/websocket$/;

const server = HTTPServer.createServer((request, response) => {
  const control_room_url_result = control_room_url_regex.exec(request.url);
  if (control_room_url_result) {
    const room_name = control_room_url_result[1];
    console.log(
      `Request received: ${request.url}. Showing control panel for room ${room_name}.`
    );
    response.writeHead(200);
    response.write(control_webpage);
    response.end();
    return;
  }
  const base_room_url_result = base_room_url_regex.exec(request.url);
  if (base_room_url_result) {
    const room_name = base_room_url_result[1];
    console.log(`Request received: ${request.url}. Showing room ${room_name}.`);
    response.writeHead(200);
    response.write(display_webpage);
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
    console.log(`[$UNK/$connection] Client rejected from ${ws.url}`);
    ws.close();
    return;
  }
  const room_name = room_websocket_url_result[1];
  if (!rooms[room_name]) {
    rooms[room_name] = {
      name: room_name,
      users: [],
      connections: [],
      is_control_locked: false,
      is_all_locked: false,
    };
  }
  const room_data = rooms[room_name];
  let user_info = null;

  console.log(`[${room_name}/$connection] Client connected`);
  ws.on('message', (raw_data) => {
    const data = JSON.parse(raw_data);
    if (data.type == 'user_login') {
      if (user_info) return;
      if (data.mode !== 'display' && data.mode !== 'control') {
        console.log(`[${room_name}/$login] Invalid proposed access mode`);
        ws.send(
          JSON.stringify({
            type: 'login_rejected',
            reason: "Access can only be granted as 'display' or 'control'",
            username: data.username,
          })
        );
        ws.close();
        return;
      }
      if (data.mode === 'control') {
        if (room_data.is_control_locked) {
          console.log(
            `[${room_name}/$login] Invalid control access to locked room`
          );
          ws.send(
            JSON.stringify({
              type: 'login_rejected',
              reason: 'The room is locked',
              username: data.username,
            })
          );
          ws.close();
          return;
        }
      }
      if (room_data.is_all_locked) {
        console.log(
          `[${room_name}/$login] Invalid access attempt to locked room`
        );
        ws.send(
          JSON.stringify({
            type: 'login_rejected',
            reason: 'The room is locked',
            username: data.username,
          })
        );
        ws.close();
        return;
      }
      if (!valid_username_regex.test(data.username)) {
        console.log(`[${room_name}/$login] Invalid proposed username`);
        ws.send(
          JSON.stringify({
            type: 'login_rejected',
            reason: 'The username contains invalid characters',
            username: data.username,
          })
        );
        ws.close();
        return;
      }
      if (room_data.users.some((u) => u.username === data.username)) {
        console.log(
          `[${room_name}/$login] Duplicate username: ${data.username}`
        );
        ws.send(
          JSON.stringify({
            type: 'login_rejected',
            reason: 'This username is already in use',
            username: data.username,
          })
        );
        ws.close();
        return;
      }
      user_info = { username: data.username, mode: data.mode };
      room_data.users.push(user_info);
      room_data.connections.push(ws);
      console.log(
        `[${room_name}/$login] Registered successfully: ${data.username}`
      );
      for (const connection of room_data.connections) {
        connection.send(
          JSON.stringify({ type: 'user_list', users: room_data.users })
        );
      }
      return;
    }

    if (!user_info) return;
    if (data.type === 'message') {
      if (data.username !== user_info.username) return;
      console.log(
        `[${room_name}/$message] ${data.username} sent ${data.message}`
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
    if (data.type === 'announcement') {
      if (data.username !== user_info.username) return;
      if (user_info.mode !== 'control') return;
      console.log(
        `[${room_name}/$announcement] ${data.username} sent ${data.message}`
      );
      for (const connection of room_data.connections) {
        connection.send(
          JSON.stringify({
            type: 'announcement',
            username: data.username,
            message: data.message,
          })
        );
      }
    }
  });
  ws.on('close', () => {
    if (!user_info) {
      console.log(`[${room_name}/$close] Non-logged in client disconnected`);
      return;
    }
    console.log(
      `[${room_name}/$close] Client ${user_info.username} disconnected`
    );
    room_data.connections = room_data.connections.filter((c) => c != ws);
    room_data.users = room_data.users.filter(
      (u) => u.username != user_info.username
    );
    const still_control = room_data.users.some((u) => u.mode === 'control');
    room_data.is_control_locked = room_data.is_control_locked && still_control;
    room_data.is_all_locked = room_data.is_all_locked && still_control;
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
