/************************************
 * sockets/index.js
 ************************************/

const {
  getGame,
  ensureSingleEmptyRoom,
  broadcastRooms,
  allPlayersReady,
  startCountdown,
  updateRoomCountForSingleUser,
  updateRoomCountForEveryone,
} = require("../utils/gameUtils");

const biggestTomato = require("./games/biggestTomato");
const agarIo = require("./games/agarIo");

module.exports = (io) => {
  // Master games object:
  // games[gameId] = { rooms: {...}, activeRooms: {...}, id, io, etc. }
  const games = {};

  // Track user info by socket
  let userList = {};

  io.on("connection", (socket) => {
    console.log(`🟢 [Server] A user connected: ${socket.id}`);

    // Provide the 'io' reference in each game object, so we can broadcast
    Object.keys(games).forEach((gameId) => {
      games[gameId].io = io;
    });

    // Update room counts for newly connected user (if any games exist)
    if (Object.keys(games).length > 0) {
      Object.entries(games).forEach(([gameId]) => {
        updateRoomCountForSingleUser(Number(gameId), socket, games, io);
      });
    }

    /********************************************
     * Track user name
     ********************************************/
    socket.on("user name", (userName, callback) => {
      if (typeof userName !== "string") {
        callback({ success: false, error: "Invalid user name." });
        return;
      }
      socket.userName = userName;
      userList[socket.id] = { id: socket.id, userName };
      io.emit("users", Object.values(userList));
      console.log(
        `[Server] user name set -> socketId=${socket.id}, userName=${userName}`
      );
    });

    /********************************************
     * Chat message event (global)
     ********************************************/
    socket.on("chat message", (msg) => {
      console.log(`[Server] chat message from ${socket.id}: ${msg}`);
      socket.broadcast.emit("chat message", msg);
    });

    /********************************************
     * Request available rooms (lobby) for a game
     ********************************************/
    socket.on("requestRooms", (gameId) => {
      // Join the "lobby" channel for that game
      socket.join(gameId);

      // Ensure we have at least one empty room
      ensureSingleEmptyRoom(gameId, games, io);
      broadcastRooms(gameId, games, io);

      console.log(
        `[Server] requestRooms -> client joined gameId=${gameId} lobby`
      );
    });

    /********************************************
     * Join a room (in the lobby)
     ********************************************/
    socket.on("joinRoom", ({ gameId, roomId, userName }) => {
      const game = getGame(gameId, games);
      if (!game.rooms[roomId]) {
        console.log(
          `[Server] joinRoom -> Room ${roomId} not found in game ${gameId}`
        );
        return;
      }

      const room = game.rooms[roomId];
      const existingPlayer = room.players.find((p) => p.socketId === socket.id);
      if (!existingPlayer) {
        // Add this player
        room.players.push({
          socketId: socket.id,
          userName: userName || socket.userName || "Unknown",
          isReady: false,
        });

        // Join the unique lobby-room channel, e.g. "1-abc123"
        const uniqueRoomChannel = `${gameId}-${roomId}`;
        socket.join(uniqueRoomChannel);
        console.log(
          `[Server] ${socket.id} joined roomId=${roomId} (lobby) in gameId=${gameId}`
        );

        // If first player, ensure we still have at least one empty room
        if (room.players.length === 1) {
          ensureSingleEmptyRoom(gameId, games, io);
        }
      }

      broadcastRooms(gameId, games, io);
    });

    /********************************************
     * Leave a lobby room
     ********************************************/
    socket.on("leaveRoom", ({ gameId, roomId }) => {
      const game = getGame(gameId, games);
      const room = game.rooms[roomId];
      if (!room) return;

      // Leave the channel
      const uniqueRoomChannel = `${gameId}-${roomId}`;
      socket.leave(uniqueRoomChannel);

      // Remove the player
      room.players = room.players.filter((p) => p.socketId !== socket.id);

      // If the room is now empty, we might remove it
      const emptyRooms = Object.values(game.rooms).filter(
        (r) => r.players.length === 0
      );
      if (room.players.length === 0 && emptyRooms.length > 1) {
        delete game.rooms[roomId];
        updateRoomCountForEveryone(gameId, games, io);
        console.log(
          `[Server] Deleted empty roomId=${roomId} in gameId=${gameId}`
        );
      }

      console.log(
        `[Server] ${socket.id} left roomId=${roomId} in gameId=${gameId}`
      );
      broadcastRooms(gameId, games, io);
    });

    /********************************************
     * Toggle player readiness in the lobby
     ********************************************/
    socket.on("toggleReady", ({ gameId, roomId, isReady }) => {
      const game = getGame(gameId, games);
      const room = game.rooms[roomId];
      if (!room) return;

      const player = room.players.find((p) => p.socketId === socket.id);
      if (player) {
        player.isReady = isReady;
        console.log(
          `[Server] toggleReady -> socketId=${socket.id}, isReady=${isReady}`
        );
      }

      // If all players in this room are ready, start the countdown
      if (allPlayersReady(room)) {
        console.log(
          `[Server] All players ready -> Starting countdown for roomId=${roomId}`
        );
        startCountdown(gameId, roomId, games, io);
      }

      broadcastRooms(gameId, games, io);
    });

    /********************************************
     * In-game actions
     ********************************************/

    // 1) Join the “in-game” channel after the game starts
    socket.on("joinGameChannel", ({ gameId, roomId }) => {
      const channel = `${gameId}-${roomId}`;
      socket.join(channel);
      console.log(
        `[Server] Socket ${socket.id} joined in-game channel: ${channel}`
      );

      // Store references in the game object so we can broadcast easily
      if (!games[gameId]) {
        return;
      }
      games[gameId].io = io;
      games[gameId].id = gameId;

      // Also store an "id" on the room so we can reference it
      if (games[gameId].rooms[roomId]) {
        games[gameId].rooms[roomId].id = roomId;
      }
      if (games[gameId].activeRooms[roomId]) {
        games[gameId].activeRooms[roomId].id = roomId;
      }
    });

    // 2) Request the current game state (active or lobby)
    socket.on("requestGameState", ({ gameId, roomId }) => {
      const game = getGame(gameId, games);

      // Check activeRooms first
      let room = game.activeRooms[roomId];
      // If not found, check the lobby rooms
      if (!room) {
        room = game.rooms[roomId];
      }

      if (!room) {
        console.log(
          `[Server] requestGameState -> roomId=${roomId} not found in gameId=${gameId}`
        );
        return;
      }

      console.log(
        `[Server] requestGameState -> broadcasting current state for ${gameId}-${roomId}`
      );
      agarIo.broadcastGameState(io, gameId, roomId, room);
    });

    // 3) For BiggestTomato (unrelated) - just an example
    socket.on("playCard", (data) => {
      data.socket = socket; // So we know who played
      biggestTomato.handlePlayCard(io, games, data);
    });

    // 4) Player movement (Agar.io)
    socket.on("playerMove", (data) => {
      data.socket = socket;
      agarIo.handlePlayerMove(io, games, data);
    });

    // 5) Shooting bullets (Agar.io)
    socket.on("shoot", (data) => {
      data.socket = socket;
      agarIo.handleShootBullet(io, games, data);
    });

    /********************************************
     * End Game Event Handler
     ********************************************/
    /**
     * Event to end the game manually or based on game logic.
     * You can trigger this event based on specific conditions in your game.
     */
    socket.on("endGame", ({ gameId, roomId }) => {
      const game = getGame(gameId, games);
      if (!game) {
        console.log(`[Server] endGame -> Game ${gameId} not found`);
        return;
      }

      // Check activeRooms
      const room = game.activeRooms[roomId];
      if (!room) {
        console.log(
          `[Server] endGame -> Room ${roomId} not found in activeRooms`
        );
        return;
      }

      // Call the cleanup function
      agarIo.endAgarIoRoom(game, room, games);

      console.log(
        `[Server] endGame -> Cleaned up roomId=${roomId} in gameId=${gameId}`
      );
    });

    /********************************************
     * Disconnection
     ********************************************/
    socket.on("disconnect", () => {
      console.log(`🔴 [Server] A user disconnected: ${socket.id}`);

      // Remove from userList
      delete userList[socket.id];
      io.emit("users", Object.values(userList));

      // Check if user was in a LOBBY room or an ACTIVE room, remove them
      Object.entries(games).forEach(([gameId, game]) => {
        // 1) Remove from LOBBY
        Object.entries(game.rooms).forEach(([roomId, room]) => {
          const playerIndex = room.players.findIndex(
            (p) => p.socketId === socket.id
          );
          if (playerIndex !== -1) {
            room.players.splice(playerIndex, 1);
            console.log(
              `[Server] Removed ${socket.id} from LOBBY roomId=${roomId} in gameId=${gameId}`
            );

            // If empty, remove it if there's more than 1 empty room
            const emptyRooms = Object.values(game.rooms).filter(
              (r) => r.players.length === 0
            );
            if (room.players.length === 0 && emptyRooms.length > 1) {
              delete game.rooms[roomId];
              ensureSingleEmptyRoom(gameId, games, io);
            }
            broadcastRooms(gameId, games, io);
          }
        });

        // 2) Remove from ACTIVE room
        Object.entries(game.activeRooms).forEach(([roomId, room]) => {
          const playerIndex = room.players.findIndex(
            (p) => p.socketId === socket.id
          );
          if (playerIndex !== -1) {
            room.players.splice(playerIndex, 1);
            console.log(
              `[Server] Removed ${socket.id} from ACTIVE roomId=${roomId} in gameId=${gameId}`
            );

            // If the room is empty, delete it
            if (room.players.length === 0) {
              delete game.activeRooms[roomId];
              console.log(
                `[Server] Deleted empty ACTIVE roomId=${roomId} in gameId=${gameId}`
              );

              // Optionally, broadcast updated rooms
              broadcastRooms(gameId, games, io);
            }
          }
        });
      });
    });
  });
};
