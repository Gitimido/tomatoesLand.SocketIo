/************************************
 * sockets/games/agarIo.js
 ************************************/

/** Dimensions of the world */
const WORLD_WIDTH = 1080;
const WORLD_HEIGHT = 1080;

/** Tick rates (reduced to 30 FPS for stability) */
const SIMULATION_RATE = 30; // simulation updates per second
const BROADCAST_RATE = 30; // broadcast updates per second

// A fast clamp function using ternaries.
function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/**
 * Start the Agar.io-like room.
 *
 * @param {Object} game - The game object.
 * @param {Object} room - The room object to start.
 * @param {Object} games - The master games object.
 */
function startAgarIoRoom(game, room, games) {
  console.log(`[Server] Starting Agar.io room, roomId=${room.id}`);

  // Initialize players using a Map for O(1) access.
  room.playersMap = new Map();
  room.alivePlayers = new Set();

  room.players.forEach((player) => {
    // Use bitwise operators to convert to an integer quickly.
    player.x = ~~(Math.random() * WORLD_WIDTH);
    player.y = ~~(Math.random() * WORLD_HEIGHT);
    player.mass = 10;
    player.isDead = false;
    player.lastDx = 0;
    player.lastDy = 0;
    room.playersMap.set(player.socketId, player);
    room.alivePlayers.add(player.socketId);
  });

  // Initialize bullets array and bullet pool.
  room.bullets = [];
  room.bulletIdCounter = 1;
  room.bulletPool = [];

  // Clear any existing intervals.
  if (room.simulationInterval) {
    clearInterval(room.simulationInterval);
    console.log(
      `[Server] Cleared previous simulationInterval for roomId=${room.id}`
    );
  }
  if (room.broadcastInterval) {
    clearInterval(room.broadcastInterval);
    console.log(
      `[Server] Cleared previous broadcastInterval for roomId=${room.id}`
    );
  }

  // Start the simulation update loop at 30 FPS.
  room.simulationInterval = setInterval(() => {
    updateBullets(game, room, games);
    // (Any additional simulation updates could be added here.)
  }, 1000 / SIMULATION_RATE);

  // Start the broadcast loop at 30 FPS.
  room.broadcastInterval = setInterval(() => {
    broadcastGameState(game.io, game.id, room.id, room);
  }, 1000 / BROADCAST_RATE);

  room.winner = null;
  console.log(`[Server] Game loop started for roomId=${room.id}`);
}

/**
 * Broadcast the entire game state (players and bullets).
 */
function broadcastGameState(io, gameId, roomId, room) {
  if (!io) return;
  const channel = `${gameId}-${roomId}`;

  const playersData = Array.from(room.alivePlayers).map((socketId) => {
    const p = room.playersMap.get(socketId);
    return {
      socketId: p.socketId,
      userName: p.userName,
      x: p.x,
      y: p.y,
      mass: p.mass,
    };
  });

  const bulletsData = room.bullets.map((b) => ({
    id: b.id,
    ownerId: b.ownerId,
    x: b.x,
    y: b.y,
    radius: b.radius,
  }));

  io.to(channel).emit("gameStateUpdate", {
    roomId,
    players: playersData,
    bullets: bulletsData,
    winner: room.winner || null,
    worldSize: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
  });
}

/**
 * Handle player movement from the client.
 */
function handlePlayerMove(io, games, data) {
  const { gameId, roomId, socket, direction } = data;
  const game = games[gameId];
  if (!game) return;

  const room = game.activeRooms[roomId] || game.rooms[roomId];
  if (!room) return;

  const player = room.playersMap.get(socket.id);
  if (!player || player.isDead) return;

  const step = 4;
  let dx = 0,
    dy = 0;
  switch (direction) {
    case "up-left":
      dx = -step;
      dy = -step;
      break;
    case "up-right":
      dx = step;
      dy = -step;
      break;
    case "down-left":
      dx = -step;
      dy = step;
      break;
    case "down-right":
      dx = step;
      dy = step;
      break;
    case "up":
      dy = -step;
      break;
    case "down":
      dy = step;
      break;
    case "left":
      dx = -step;
      break;
    case "right":
      dx = step;
      break;
    default:
      break;
  }

  player.x = clamp(player.x + dx, 0, WORLD_WIDTH);
  player.y = clamp(player.y + dy, 0, WORLD_HEIGHT);

  if (dx || dy) {
    player.lastDx = dx;
    player.lastDy = dy;
  }
  // Note: We avoid immediate broadcasts to reduce per-action load.
}

/**
 * Handle shooting a bullet.
 */
function handleShootBullet(io, games, data) {
  const { gameId, roomId, socket, bulletType, direction } = data;
  const game = games[gameId];
  if (!game) return;

  const room = game.activeRooms[roomId] || game.rooms[roomId];
  if (!room) return;

  const player = room.playersMap.get(socket.id);
  if (!player || player.isDead) return;

  if (
    !direction ||
    typeof direction.x !== "number" ||
    typeof direction.y !== "number" ||
    !["charged", "fullyCharged"].includes(bulletType)
  ) {
    return;
  }

  let speedValue, radius, rangeLimit;
  switch (bulletType) {
    case "fullyCharged":
      speedValue = 30;
      radius = 25;
      rangeLimit = Infinity;
      break;
    case "charged":
      speedValue = 30;
      radius = 5;
      rangeLimit = Infinity;
      break;
    default:
      return;
  }

  const len =
    Math.sqrt(direction.x * direction.x + direction.y * direction.y) || 1;
  const vx = (direction.x / len) * speedValue;
  const vy = (direction.y / len) * speedValue;

  let bullet;
  if (room.bulletPool.length > 0) {
    bullet = room.bulletPool.pop();
    bullet.id = room.bulletIdCounter++;
    bullet.ownerId = player.socketId;
    bullet.x = player.x;
    bullet.y = player.y;
    bullet.vx = vx;
    bullet.vy = vy;
    bullet.radius = radius;
    bullet.traveled = 0;
    bullet.rangeLimit = rangeLimit;
    bullet.type = bulletType;
    bullet.speed = speedValue;
  } else {
    bullet = {
      id: room.bulletIdCounter++,
      ownerId: player.socketId,
      x: player.x,
      y: player.y,
      vx,
      vy,
      radius,
      traveled: 0,
      rangeLimit,
      type: bulletType,
      speed: speedValue,
    };
  }

  room.bullets.push(bullet);
  io.to(`${game.id}-${room.id}`).emit("bulletCreated", bullet);
}

/**
 * Update bullets: move them, check for collisions, and recycle them.
 */
function updateBullets(game, room, games) {
  if (!room.bullets || !room.playersMap) return;

  for (let i = room.bullets.length - 1; i >= 0; i--) {
    const b = room.bullets[i];
    b.x += b.vx;
    b.y += b.vy;
    // Use the precomputed speed to update the distance traveled.
    b.traveled += b.speed;

    if (
      b.x < 0 ||
      b.x > WORLD_WIDTH ||
      b.y < 0 ||
      b.y > WORLD_HEIGHT ||
      (b.rangeLimit !== Infinity && b.traveled >= b.rangeLimit)
    ) {
      room.bulletPool.push(b);
      room.bullets.splice(i, 1);
      continue;
    }

    let collisionDetected = false;
    for (const player of room.playersMap.values()) {
      if (player.socketId === b.ownerId || player.isDead) continue;
      const dx = b.x - player.x;
      const dy = b.y - player.y;
      const collisionDistance = b.radius + player.mass;
      if (dx * dx + dy * dy < collisionDistance * collisionDistance) {
        player.isDead = true;
        room.alivePlayers.delete(player.socketId);
        room.bulletPool.push(b);
        room.bullets.splice(i, 1);
        console.log(
          `[Server] Player ${player.userName} was killed by bullet ${b.id}`
        );
        collisionDetected = true;
        break;
      }
    }
    if (collisionDetected) continue;
  }

  // Check win condition (0 or 1 player left).
  if (room.alivePlayers.size <= 1 && !room.winner) {
    if (room.alivePlayers.size === 1) {
      const winnerId = Array.from(room.alivePlayers)[0];
      const winnerPlayer = room.playersMap.get(winnerId);
      room.winner = winnerPlayer ? winnerPlayer.userName : null;
      console.log(`[Server] Player ${room.winner} has won roomId=${room.id}`);
    } else {
      room.winner = null;
      console.log(`[Server] No players left alive in roomId=${room.id}`);
    }
    endAgarIoRoom(game, room, games);
  }
}

/**
 * Cleanup the game room and notify clients.
 */
function endAgarIoRoom(game, room, games) {
  console.log(`[Server] Ending Agar.io room: ${room.id}`);

  if (room.simulationInterval) {
    clearInterval(room.simulationInterval);
    room.simulationInterval = null;
    console.log(`[Server] Cleared simulationInterval for roomId=${room.id}`);
  }
  if (room.broadcastInterval) {
    clearInterval(room.broadcastInterval);
    room.broadcastInterval = null;
    console.log(`[Server] Cleared broadcastInterval for roomId=${room.id}`);
  }

  if (room.bullets) {
    room.bullets.forEach((bullet) => room.bulletPool.push(bullet));
    room.bullets = [];
  }

  if (room.playersMap) {
    room.playersMap.forEach((player) => {
      player.isDead = false;
      player.mass = 10;
    });
  }

  if (game.activeRooms[room.id]) {
    delete game.activeRooms[room.id];
    console.log(`[Server] Removed roomId=${room.id} from activeRooms`);
  }

  game.io.to(`${game.id}-${room.id}`).emit("gameEnded", {
    roomId: room.id,
    winner: room.winner,
  });
}

module.exports = {
  startAgarIoRoom,
  broadcastGameState,
  handlePlayerMove,
  handleShootBullet,
  endAgarIoRoom,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  SIMULATION_RATE,
  BROADCAST_RATE,
};
