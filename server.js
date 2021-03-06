const fs = require("fs");
const HTTPServer = require("http");
const WebSocket = require("ws");

let index_webpage = fs.readFileSync("static/index.html");
fs.watchFile("static/index.html", { interval: 1000 }, () => {
  console.log("Reloaded index.html");
  index_webpage = fs.readFileSync("static/index.html");
});

let display_webpage = fs.readFileSync("static/display.html");
fs.watchFile("static/display.html", { interval: 1000 }, () => {
  console.log("Reloaded display.html");
  display_webpage = fs.readFileSync("static/display.html");
});

const background_directory = "background";
let default_background_path = null;
let background_list = [];
function reloadBackgroundDirectory() {
  console.log("Reloaded background files");
  background_list.length = 0;
  const file_list = fs.readdirSync(background_directory);
  for (const file_name of file_list) {
    if (!file_name.endsWith(".mp4") && !file_name.endsWith(".gif")) continue;
    const display_name = file_name.slice(0, -4);
    background_list.push({
      display_name: display_name,
      url_path: `/room/$background/${file_name}`,
      file_name: file_name,
      file_path: `${background_directory}/${file_name}`,
    });
  }
  default_background_path = background_list[0]
    ? background_list[0].url_path
    : null;
}
fs.watch(background_directory, { recursive: false }, reloadBackgroundDirectory);
reloadBackgroundDirectory();

let control_webpage = fs.readFileSync("static/control.html");
fs.watchFile("static/control.html", { interval: 1000 }, () => {
  console.log("Reloaded control.html");
  control_webpage = fs.readFileSync("static/control.html");
});

/** @type {{
  [key: string]: {
    name: room_name,
    users: { username: string, mode: 'display' | 'control' }[],
    connections: WebSocket[],
    is_control_locked: boolean,
    is_all_locked: boolean,
    background: {
      url: string | null,
      is_trusted: boolean,
    },
  }
}} */
const rooms = {};

const valid_username_regex = /^[\w ()]{0,32}$/;
const background_url_regex =
  /^\/room\/\$background\/([\w-]{1,64}(?:\.mp4|\.gif))$/;
const base_room_url_regex = /^\/room\/(\w{1,64})\/?$/;
const control_room_url_regex = /^\/room\/(\w{1,64})\/control$/;
const room_websocket_url_regex = /^\/room\/(\w{1,64})\/websocket$/;

function handleBackgroundRequest(filename, request, response) {
  const file_path = `${background_directory}/${filename}`;
  fs.access(file_path, (err) => {
    if (err) {
      console.log(`Request received: ${request.url}. Sending 404.`);
      response.writeHead(404);
      response.end();
      return;
    }
    fs.stat(file_path, (err, file_info) => {
      const content_type = file_path.endsWith(".mp4")
        ? "video/mp4"
        : file_path.endsWith(".gif")
        ? "image/gif"
        : "text/plain";
      if (err) {
        console.log(`Request received: ${request.url}. Sending 404.`);
        response.writeHead(404);
        response.end();
        return;
      }
      const range = request.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : file_info.size - 1;
        const chunksize = end - start + 1;
        const file_stream = fs.createReadStream(file_path, {
          start: start,
          end: end,
        });
        console.log(
          `Request received: ${request.url} with range ${start}-${end}. Sending file.`
        );
        response.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${file_info.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunksize,
          "Content-Type": content_type,
        });
        file_stream.pipe(response);
        return;
      } else {
        response.writeHead(200, {
          "Content-Length": file_info.size,
          "Content-Type": content_type,
        });
        console.log(`Request received: ${request.url}. Sending file.`);
        const file_stream = fs.createReadStream(file_path);
        file_stream.pipe(response);
        return;
      }
    });
  });
}

const server = HTTPServer.createServer((request, response) => {
  const background_url_result = background_url_regex.exec(request.url);
  if (background_url_result) {
    const filename = background_url_result[1];
    handleBackgroundRequest(filename, request, response);
    return;
  }
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

function getOrCreateRoom(room_name) {
  if (!rooms[room_name]) {
    rooms[room_name] = {
      name: room_name,
      users: [],
      connections: [],
      is_control_locked: false,
      is_all_locked: false,
      background: {
        url: default_background_path,
        is_trusted: true,
      },
    };
  }
  return rooms[room_name];
}

function getRoomStatus(room_data) {
  return {
    type: "status",
    is_control_locked: room_data.is_control_locked,
    is_all_locked: room_data.is_all_locked,
    users: room_data.users,
    background: {
      url: room_data.background.url,
      is_trusted: room_data.background.is_trusted,
    },
    background_choices: background_list.map((b) => ({
      name: b.display_name,
      url: b.url_path,
    })),
  };
}

function handleUserLogin(room_data, user_info, room_name, data, ws) {
  if (user_info) return user_info;
  if (data.mode !== "display" && data.mode !== "control") {
    console.log(`[${room_name}/$login] Invalid proposed access mode`);
    ws.send(
      JSON.stringify({
        type: "login_rejected",
        reason: "Access can only be granted as 'display' or 'control'",
        username: data.username,
      })
    );
    ws.close();
    return null;
  }
  if (data.mode === "control") {
    if (room_data.is_control_locked) {
      console.log(
        `[${room_name}/$login] Invalid control access to locked room`
      );
      ws.send(
        JSON.stringify({
          type: "login_rejected",
          reason: "The room is locked",
          username: data.username,
        })
      );
      ws.close();
      return null;
    }
  }
  if (room_data.is_all_locked) {
    console.log(`[${room_name}/$login] Invalid access attempt to locked room`);
    ws.send(
      JSON.stringify({
        type: "login_rejected",
        reason: "The room is locked",
        username: data.username,
      })
    );
    ws.close();
    return null;
  }
  if (!valid_username_regex.test(data.username)) {
    console.log(`[${room_name}/$login] Invalid proposed username`);
    ws.send(
      JSON.stringify({
        type: "login_rejected",
        reason: "The username contains invalid characters",
        username: data.username,
      })
    );
    ws.close();
    return null;
  }
  if (room_data.users.some((u) => u.username === data.username)) {
    console.log(`[${room_name}/$login] Duplicate username: ${data.username}`);
    ws.send(
      JSON.stringify({
        type: "login_rejected",
        reason: "This username is already in use",
        username: data.username,
      })
    );
    ws.close();
    return null;
  }
  user_info = { username: data.username, mode: data.mode };
  room_data.users.push(user_info);
  room_data.connections.push(ws);
  console.log(
    `[${room_name}/$login] Registered successfully: ${data.username}`
  );
  for (const connection of room_data.connections) {
    connection.send(JSON.stringify(getRoomStatus(room_data)));
  }
  return user_info;
}

function handleUserSendMessage(room_data, user_info, room_name, data, ws) {
  if (data.username !== user_info.username) return;
  console.log(`[${room_name}/$message] ${data.username} sent ${data.message}`);
  for (const connection of room_data.connections) {
    connection.send(
      JSON.stringify({
        type: "message",
        username: data.username,
        message: data.message,
      })
    );
  }
}

function handleUserSendAnnouncement(room_data, user_info, room_name, data, ws) {
  if (data.username !== user_info.username) return;
  if (user_info.mode !== "control") return;
  console.log(
    `[${room_name}/$announcement] ${data.username} sent ${data.message}`
  );
  for (const connection of room_data.connections) {
    connection.send(
      JSON.stringify({
        type: "announcement",
        username: data.username,
        message: data.message,
      })
    );
  }
}

function handleUserSetControlLock(room_data, user_info, room_name, data, ws) {
  if (data.username !== user_info.username) return;
  if (user_info.mode !== "control") return;
  console.log(
    `[${room_name}/$control_lock] ${data.username} set lock = ${!!data.value}`
  );
  room_data.is_control_locked = !!data.value;
  for (const connection of room_data.connections) {
    connection.send(JSON.stringify(getRoomStatus(room_data)));
  }
}

function handleUserSetRoomLock(room_data, user_info, room_name, data, ws) {
  if (data.username !== user_info.username) return;
  if (user_info.mode !== "control") return;
  console.log(
    `[${room_name}/$room_lock] ${data.username} set lock = ${!!data.value}`
  );
  room_data.is_all_locked = !!data.value;
  for (const connection of room_data.connections) {
    connection.send(JSON.stringify(getRoomStatus(room_data)));
  }
}

function handleUserSetBackground(room_data, user_info, room_name, data, ws) {
  if (data.username !== user_info.username) return;
  if (user_info.mode !== "control") return;
  if (data.url) {
    const bg_info = background_list.find((b) => b.url_path === data.url);
    if (!bg_info) {
      // This background doesn't come from the default list, and shouldn't be trusted.
      console.log(
        `[${room_name}/$background] ${data.username} set background = [DATA EXPUNGED] (untrusted)`
      );
      room_data.background.url = data.url;
      room_data.background.is_trusted = false;
    } else {
      if (room_data.background === bg_info.url_path) return;
      console.log(
        `[${room_name}/$background] ${data.username} set background = ${bg_info.display_name}`
      );
      room_data.background.url = bg_info.url_path;
      room_data.background.is_trusted = true;
    }
  } else {
    if (!room_data.background) return;
    console.log(
      `[${room_name}/$background] ${data.username} set background = null`
    );
    room_data.background.url = null;
    room_data.background.is_trusted = true;
  }
  for (const connection of room_data.connections) {
    connection.send(JSON.stringify(getRoomStatus(room_data)));
  }
}

function handleUserDisconnect(room_data, user_info, room_name, ws) {
  console.log(
    `[${room_name}/$close] Client ${user_info.username} disconnected`
  );
  room_data.connections = room_data.connections.filter((c) => c != ws);
  room_data.users = room_data.users.filter(
    (u) => u.username != user_info.username
  );
  // Unlock the room if there's no controller left
  const still_control = room_data.users.some((u) => u.mode === "control");
  room_data.is_control_locked = room_data.is_control_locked && still_control;
  room_data.is_all_locked = room_data.is_all_locked && still_control;
  // Notify all remaining connections of the new user list and status
  for (const connection of room_data.connections) {
    connection.send(JSON.stringify(getRoomStatus(room_data)));
  }
  // If the room is empty, remove the room from the global rooms.
  if (!room_data.connections.length) {
    console.log(`[${room_name}/$close] Room is empty, deleting room storage`);
    delete rooms[room_name];
  }
}

const websocket = new WebSocket.Server({ noServer: true });
websocket.on("connection", (ws, socket) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  const room_websocket_url_result = room_websocket_url_regex.exec(socket.url);
  if (!room_websocket_url_result) {
    console.log(`[$UNK/$connection] Client rejected from ${ws.url}`);
    ws.close();
    return;
  }
  const room_name = room_websocket_url_result[1];
  const room_data = getOrCreateRoom(room_name);
  let user_info = null;

  console.log(`[${room_name}/$connection] Client connected`);
  ws.on("message", (raw_data) => {
    const data = JSON.parse(raw_data);
    if (data.type == "user_login") {
      user_info = handleUserLogin(room_data, user_info, room_name, data, ws);
      return;
    }

    if (!user_info) return;
    if (data.type === "message") {
      handleUserSendMessage(room_data, user_info, room_name, data, ws);
      return;
    }
    if (data.type === "announcement") {
      handleUserSendAnnouncement(room_data, user_info, room_name, data, ws);
      return;
    }
    if (data.type === "control_lock") {
      handleUserSetControlLock(room_data, user_info, room_name, data, ws);
      return;
    }
    if (data.type === "room_lock") {
      handleUserSetRoomLock(room_data, user_info, room_name, data, ws);
      return;
    }
    if (data.type === "background") {
      handleUserSetBackground(room_data, user_info, room_name, data, ws);
      return;
    }
  });
  ws.on("close", () => {
    if (!user_info) {
      console.log(`[${room_name}/$close] Non-logged in client disconnected`);
      return;
    }
    handleUserDisconnect(room_data, user_info, room_name, ws);
  });
});

setInterval(() => {
  websocket.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.on("upgrade", (request, socket, head) => {
  if (room_websocket_url_regex.test(request.url)) {
    websocket.handleUpgrade(request, socket, head, (ws) => {
      websocket.emit("connection", ws, request);
    });
    return;
  }

  socket.destroy();
});

server.on("listening", () => {
  console.log(`Server started at http://localhost:18029/room/`);
});

server.listen(18029, "localhost");
