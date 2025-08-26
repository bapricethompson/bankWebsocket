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

  if (room.interval) clearTimeout(room.interval);
  room.roundTotal = 0;
  room.rollCount = 0;
  room.banked.clear();
  room.snakeEyesThisRound = false;

  // Reset streak bonus counters for players who activated it
  for (const playerName in room.powerups) {
    if (room.powerups[playerName].streak_bonus.active) {
      room.powerups[playerName].streak_bonus.rollCount = 0;
    }
  }

  broadcast(roomCode, {
    type: "round_update",
    round: room.currentRound,
    maxRounds: room.maxRounds,
  });

  function scheduleRoll() {
    const rollTime = Date.now() + 5000; // Next roll in 5 seconds
    broadcast(roomCode, {
      type: "roll_scheduled",
      rollTime,
    });

    room.interval = setTimeout(() => {
      if (room.banked.size === Object.keys(room.players).length) {
        console.log("All players banked!");
        room.currentRound++;
        if (room.currentRound <= room.maxRounds) {
          startRound(roomCode);
        } else {
          endGame(roomCode);
        }
        return;
      }

      const d1 = rollDie();
      const d2 = rollDie();
      const sum = d1 + d2;
      room.rollCount++;

      let message = null;

      // Check for snake eyes
      if (d1 === 1 && d2 === 1) {
        room.snakeEyesThisRound = true;
      }

      // Handle streak bonus roll counting
      for (const playerName in room.powerups) {
        const power = room.powerups[playerName].streak_bonus;
        if (power.active) {
          power.rollCount++;
          if (sum === 7) {
            // 7 rolled, player loses 300 points
            room.leaderboard[playerName] = Math.max(
              0,
              room.leaderboard[playerName] - 300
            );
            power.active = false;
            room.players[playerName].send(
              JSON.stringify({
                type: "powerup_result",
                name: "streak_bonus",
                message: "💥 7 rolled during Streak Bonus! -300 points.",
                points: -300,
              })
            );
            broadcast(roomCode, {
              type: "leaderboard_update",
              leaderboard: room.leaderboard,
            });
          } else if (power.rollCount >= 3) {
            // Survived 3 rolls, gain 300 points
            room.leaderboard[playerName] += 300;
            power.active = false;
            room.players[playerName].send(
              JSON.stringify({
                type: "powerup_result",
                name: "streak_bonus",
                message: "🎉 Survived 3 rolls! +300 points!",
                points: 300,
              })
            );
            broadcast(roomCode, {
              type: "leaderboard_update",
              leaderboard: room.leaderboard,
            });
          }
        }
      }

      if (room.rollCount <= 3) {
        if (sum === 7) {
          room.roundTotal += 70;
          message = "🧨 Early 7! +70 added.";
        } else if (d1 === d2) {
          room.roundTotal += d1 + d2;
          message = `🎁 Early double! +${d1 + d2} added.`;
        } else {
          room.roundTotal += sum;
        }
      } else {
        if (sum === 7) {
          message = "💥 Rolled a 7. Round total lost!";
          room.roundTotal = 0;

          // Apply snake eyes power-up results
          for (const playerName in room.powerups) {
            const power = room.powerups[playerName].snake_eyes;
            if (power.active) {
              power.active = false;
              const points = room.snakeEyesThisRound ? 100 : -100;
              room.leaderboard[playerName] = Math.max(
                0,
                room.leaderboard[playerName] + points
              );
              room.players[playerName].send(
                JSON.stringify({
                  type: "powerup_result",
                  name: "snake_eyes",
                  message: room.snakeEyesThisRound
                    ? "🐍 Snake Eyes rolled! +100 points!"
                    : "😞 No Snake Eyes. -100 points.",
                  points,
                })
              );
              broadcast(roomCode, {
                type: "leaderboard_update",
                leaderboard: room.leaderboard,
              });
            }
          }

          broadcast(roomCode, { type: "roll", d1, d2, sum, pot: 0, message });

          clearTimeout(room.interval);
          room.interval = null;

          setTimeout(() => {
            room.currentRound++;
            if (room.currentRound <= room.maxRounds) {
              startRound(roomCode);
            } else {
              endGame(roomCode);
            }
          }, 5000);

          return;
        } else if (d1 === d2) {
          room.roundTotal *= 2;
          message = `🔥 Doubles! Round total doubled to ${room.roundTotal}`;
        } else {
          room.roundTotal += sum;
        }
      }

      // Handle double or nothing power-up
      for (const playerName in room.powerups) {
        const power = room.powerups[playerName].double_or_nothing;
        if (power.active) {
          power.active = false;
          room.banked.add(playerName);
          if (sum === 7) {
            room.leaderboard[playerName] *= 2;
            room.players[playerName].send(
              JSON.stringify({
                type: "powerup_result",
                name: "double_or_nothing",
                message: "🎰 7 rolled! Points doubled and banked!",
                points: room.leaderboard[playerName],
              })
            );
          } else {
            room.leaderboard[playerName] = 0;
            room.players[playerName].send(
              JSON.stringify({
                type: "powerup_result",
                name: "double_or_nothing",
                message: "😢 No 7 rolled. Points reset to 0 and banked.",
                points: 0,
              })
            );
          }
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
      }

      broadcast(roomCode, {
        type: "roll",
        d1,
        d2,
        sum,
        pot: room.roundTotal,
        message,
      });

      // Schedule the next roll
      scheduleRoll();
    }, 5000);
  }

  scheduleRoll();
}

function endGame(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const sortedEntries = Object.entries(room.leaderboard).sort(
    (a, b) => b[1] - a[1]
  );

  const topPlayers = sortedEntries.slice(0, 3).map(([name, score]) => ({
    name,
    score,
  }));

  const playerRanks = {};
  sortedEntries.forEach(([name, score], index) => {
    playerRanks[name] = { rank: index + 1, score };
  });

  for (const [playerName, socket] of Object.entries(room.players)) {
    const playerData = playerRanks[playerName];
    if (!playerData || socket.readyState !== WebSocket.OPEN) continue;

    socket.send(
      JSON.stringify({
        type: "game_over",
        leaderboard: room.leaderboard,
        topPlayers,
        yourPlacement: playerData,
      })
    );
  }

  room.state = "waiting";
}

wss.on("connection", (socket) => {
  socket.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      const { type } = data;

      if (type === "host_create") {
        const roomCode = data.room;
        const maxRounds = parseInt(data.maxRounds) || 10;

        if (rooms[roomCode]) {
          socket.send(
            JSON.stringify({ type: "error", message: "Room already exists." })
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
          powerups: {},
          state: "waiting",
          snakeEyesThisRound: false,
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
            JSON.stringify({ type: "error", message: "Name required." })
          );
          return;
        }
        if (room.players[name]) {
          socket.send(
            JSON.stringify({ type: "error", message: "Name taken." })
          );
          return;
        }

        socket.username = name;
        socket.roomCode = roomCode;
        room.players[name] = socket;
        room.leaderboard[name] = 0;
        room.powerups[name] = {
          snake_eyes: { active: false, used: false, threshold: 100 },
          streak_bonus: {
            active: false,
            used: false,
            threshold: 300,
            rollCount: 0,
          },
          double_or_nothing: { active: false, used: false, threshold: 50 },
        };

        broadcast(roomCode, {
          type: "lobby_update",
          players: Object.keys(room.players),
        });

        broadcast(roomCode, {
          type: "leaderboard_update",
          leaderboard: room.leaderboard,
        });
      } else if (type === "start_game") {
        const roomCode = socket.roomCode;
        const room = rooms[roomCode];

        if (!room || socket !== room.host) {
          socket.send(
            JSON.stringify({ type: "error", message: "Only host can start." })
          );
          return;
        }
        if (room.state !== "waiting") {
          socket.send(
            JSON.stringify({ type: "error", message: "Game already started." })
          );
          return;
        }

        room.state = "playing";
        room.currentRound = 1;

        broadcast(roomCode, {
          type: "game_start",
          message: "🚀 Game is starting!",
          players: Object.keys(room.players),
          maxRounds: room.maxRounds,
        });

        startRound(roomCode);
      } else if (type === "bank") {
        const playerName = socket.username;
        const roomCode = socket.roomCode;
        const room = rooms[roomCode];
        if (!room || !room.players[playerName]) return;

        if (!room.banked.has(playerName)) {
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

          if (room.banked.size === Object.keys(room.players).length) {
            clearTimeout(room.interval);
            room.interval = null;
            room.currentRound++;

            // Apply snake eyes power-up results if round ends without a 7
            for (const playerName in room.powerups) {
              const power = room.powerups[playerName].snake_eyes;
              if (power.active) {
                power.active = false;
                const points = room.snakeEyesThisRound ? 100 : -100;
                room.leaderboard[playerName] = Math.max(
                  0,
                  room.leaderboard[playerName] + points
                );
                room.players[playerName].send(
                  JSON.stringify({
                    type: "powerup_result",
                    name: "snake_eyes",
                    message: room.snakeEyesThisRound
                      ? "🐍 Snake Eyes rolled! +100 points!"
                      : "😞 No Snake Eyes. -100 points.",
                    points,
                  })
                );
                broadcast(roomCode, {
                  type: "leaderboard_update",
                  leaderboard: room.leaderboard,
                });
              }
            }

            if (room.currentRound <= room.maxRounds) {
              startRound(roomCode);
            } else {
              endGame(roomCode);
            }
          }
        }
      } else if (type === "use_powerup") {
        const playerName = socket.username;
        const roomCode = socket.roomCode;
        const room = rooms[roomCode];
        if (!room || !room.players[playerName]) return;

        const powerName = data.name;
        const power = room.powerups[playerName][powerName];
        if (!power) {
          socket.send(
            JSON.stringify({ type: "error", message: "Invalid powerup." })
          );
          return;
        }
        if (power.used) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: "Powerup already used in this game.",
            })
          );
          return;
        }
        if (power.active) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: "Powerup already active.",
            })
          );
          return;
        }

        // Calculate total potential loss from all power-ups
        let potentialLoss = 0;
        if (
          powerName === "snake_eyes" ||
          room.powerups[playerName].snake_eyes.active
        ) {
          potentialLoss += 100;
        }
        if (
          powerName === "streak_bonus" ||
          room.powerups[playerName].streak_bonus.active
        ) {
          potentialLoss += 300;
        }
        if (
          powerName === "double_or_nothing" ||
          room.powerups[playerName].double_or_nothing.active
        ) {
          potentialLoss += room.leaderboard[playerName];
        }

        if (room.leaderboard[playerName] < potentialLoss) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: `Need ${potentialLoss} points to cover potential losses for ${powerName}.`,
            })
          );
          return;
        }

        power.active = true;
        power.used = true;
        socket.send(
          JSON.stringify({
            type: "powerup_activated",
            name: powerName,
            message: `${powerName} activated!`,
          })
        );
        broadcast(roomCode, {
          type: "powerup_used",
          player: playerName,
          name: powerName,
        });
      }
    } catch (err) {
      console.error("Bad message:", err);
      socket.send(
        JSON.stringify({ type: "error", message: "Malformed request." })
      );
    }
  });

  socket.on("close", () => {
    const roomCode = socket.roomCode;
    const room = rooms[roomCode];
    if (!room) return;

    const playerName = Object.keys(room.players).find(
      (name) => room.players[name] === socket
    );

    if (playerName) {
      delete room.players[playerName];
      delete room.leaderboard[playerName];
      delete room.powerups[playerName];

      broadcast(roomCode, {
        type: "leaderboard_update",
        leaderboard: room.leaderboard,
      });
      broadcast(roomCode, {
        type: "lobby_update",
        players: Object.keys(room.players),
      });
    }
  });
});

console.log(`WebSocket server running on ws://localhost:8080`);
