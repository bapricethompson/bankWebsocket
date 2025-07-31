const WebSocket = require("ws");
const PORT = process.env.PORT || 8080;

const wss = new WebSocket.Server({ port: PORT });
const rooms = {};

function broadcast(roomCode, data) {
  const room = rooms[roomCode];
  if (!room) return;
  for (const socket of Object.values(room.players)) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(data));
    }
  }
}

function rollDie() {
  return Math.floor(Math.random() * 6) + 1;
}

function startRound(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  if (room.interval) clearInterval(room.interval);
  room.roundTotal = 0;
  room.rollCount = 0;
  room.banked.clear();
  console.log("round");
  broadcast(roomCode, {
    type: "round_update",
    round: room.currentRound,
    maxRounds: room.maxRounds,
  });

  room.interval = setInterval(() => {
    if (room.banked.size === Object.keys(room.players).length) {
      // All players have banked
      console.log("All players have banked!");
      // You can trigger next round or any other logic here
    }

    const d1 = rollDie();
    const d2 = rollDie();
    const sum = d1 + d2;

    console.log(`Die roll ${d1} and ${d2} (Room ${roomCode})`);
    room.rollCount++;

    let message = null;

    if (room.rollCount <= 3) {
      if (sum === 7) {
        room.roundTotal += 70;
        message = "🧨 Early 7! +70 added.";
      } else if (d1 === d2) {
        room.roundTotal += d1;
        message = `🎁 Early double! +${d1} added.`;
      } else {
        room.roundTotal += sum;
      }
    } else {
      if (sum === 7) {
        message = "💥 Rolled a 7. Round total lost!";
        room.roundTotal = 0;

        broadcast(roomCode, {
          type: "roll",
          d1,
          d2,
          sum,
          pot: room.roundTotal,
          message,
        });

        clearInterval(room.interval);
        room.interval = null;

        setTimeout(() => {
          room.currentRound++;
          if (room.currentRound <= room.maxRounds) {
            startRound(roomCode);
          } else {
            const sortedEntries = Object.entries(room.leaderboard).sort(
              (a, b) => b[1] - a[1]
            );

            const topPlayers = sortedEntries
              .slice(0, 3)
              .map(([name, score]) => ({
                name,
                score,
              }));

            // Create a map of player name -> rank (1-indexed)
            const playerRanks = {};
            sortedEntries.forEach(([name, score], index) => {
              playerRanks[name] = {
                rank: index + 1,
                score,
              };
            });

            // Broadcast game over info with full ranking per player
            for (const [playerName, socket] of Object.entries(room.players)) {
              const playerData = playerRanks[playerName];
              if (!playerData || socket.readyState !== WebSocket.OPEN) continue;

              socket.send(
                JSON.stringify({
                  type: "game_over",
                  leaderboard: room.leaderboard,
                  topPlayers,
                  yourPlacement: {
                    rank: playerData.rank,
                    score: playerData.score,
                  },
                })
              );
            }
          }
        }, 4000);

        return;
      } else if (d1 === d2) {
        room.roundTotal *= 2;
        message = `🔥 Doubles! Round total doubled to ${room.roundTotal}`;
      } else {
        room.roundTotal += sum;
      }
    }

    broadcast(roomCode, {
      type: "roll",
      d1,
      d2,
      sum,
      pot: room.roundTotal,
      message,
    });
  }, 4000);
}

wss.on("connection", (socket) => {
  socket.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      const { type } = data;

      if (type === "host_create") {
        const roomCode = data.room;
        const maxRounds = parseInt(data.maxRounds) || 10;
        console.log(maxRounds);
        if (rooms[roomCode]) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: "Room code already in use.",
            })
          );
          return;
        }

        rooms[roomCode] = {
          host: socket,
          players: {},
          leaderboard: {},
          roundTotal: 0,
          rollCount: 0,
          banked: new Set(),
          interval: null,
          currentRound: 1,
          maxRounds,
        };

        socket.isHost = true;
        socket.roomCode = roomCode;
        socket.username = "HOST";
        socket.send(JSON.stringify({ type: "room_created", room: roomCode }));
      } else if (type === "join") {
        const roomCode = data.room;
        const name = data.name?.trim();
        const room = rooms[roomCode];

        if (!room) {
          socket.send(
            JSON.stringify({ type: "error", message: "Room not found." })
          );
          return;
        }

        if (!name) {
          socket.send(
            JSON.stringify({ type: "error", message: "Name cannot be empty." })
          );
          return;
        }

        if (room.players[name]) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: `Name '${name}' is already taken.`,
            })
          );
          return;
        }

        socket.username = name;
        socket.roomCode = roomCode;
        room.players[name] = socket;
        room.leaderboard[name] = 0;

        broadcast(roomCode, {
          type: "leaderboard_update",
          leaderboard: room.leaderboard,
        });
      } else if (type === "start_game") {
        const roomCode = socket.roomCode;
        const room = rooms[roomCode];

        console.log(`Game started in room ${roomCode}`);

        if (!room || socket !== room.host) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: "Only host can start the game.",
            })
          );
          return;
        }

        room.currentRound = 1;
        startRound(roomCode);
      } else if (type === "bank") {
        const playerName = socket.username;
        const roomCode = socket.roomCode;
        const room = rooms[roomCode];

        if (!room || !room.players[playerName]) return;
        if (room.banked.has(playerName)) return;

        room.banked.add(playerName);
        room.leaderboard[playerName] += room.roundTotal;

        broadcast(roomCode, {
          type: "banked",
          name: playerName,
          newScore: room.leaderboard[playerName],
        });

        broadcast(roomCode, {
          type: "leaderboard_update",
          leaderboard: room.leaderboard,
        });
      }
    } catch (err) {
      console.error("Invalid message:", err);
      socket.send(
        JSON.stringify({ type: "error", message: "Malformed request." })
      );
    }
  });

  socket.on("close", () => {
    const roomCode = socket.roomCode;
    const name = socket.username;
    const room = rooms[roomCode];
    if (room && name && room.players[name]) {
      delete room.players[name];
      delete room.leaderboard[name];
      broadcast(roomCode, {
        type: "leaderboard_update",
        leaderboard: room.leaderboard,
      });
    }
  });
});

console.log("WebSocket server started on ws://localhost:8080");
