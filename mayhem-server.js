/**
 * 🎤 MUSIC MAYHEM — Game Server
 * Plugs into the existing BOSHD game server ping system
 * Node.js + WebSocket (ws) + Express
 *
 * Install deps: npm install express ws node-fetch
 */

const express = require("express");
const { WebSocketServer } = require("ws");
const http = require("http");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3007;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ─────────────────────────────────────────
// GAME STATE
// ─────────────────────────────────────────

const games = {}; // keyed by gameCode

function createGame(gameCode, theme = "mixed") {
  return {
    gameCode,
    theme,
    phase: "lobby",       // lobby | clip | ai-question | reveal | scoreboard | end
    round: 0,
    totalRounds: 5,
    players: {},          // socketId → { name, score, buzzed }
    tvSocket: null,
    currentClip: null,    // { trackName, artistName, previewUrl, albumArt }
    currentQuestion: null,// { question, options, correct, funFact }
    buzzerWinner: null,
    answers: {},          // socketId → answer
    roundSchedule: [      // alternates clip and AI rounds
      "clip", "ai", "clip", "ai", "mayhem"
    ],
    clips: [],            // pre-fetched iTunes clips
    clipIndex: 0,
    timer: null,
  };
}

// ─────────────────────────────────────────
// PING ENDPOINT — BOSHD routing system
// ─────────────────────────────────────────

app.get("/ping", (req, res) => {
  res.json({ game: "music-mayhem", status: "ready", label: "🎤 Music Mayhem" });
});

app.get("/game/:code", (req, res) => {
  const g = games[req.params.code];
  if (!g) return res.status(404).json({ error: "Game not found" });
  res.json({ game: "music-mayhem", phase: g.phase, theme: g.theme });
});

// ─────────────────────────────────────────
// ITUNES — Fetch clips for a theme
// ─────────────────────────────────────────

async function fetchItunesClips(theme, count = 15) {
  const themeMap = {
    "90s": "90s hits",
    "80s": "80s hits",
    "pop": "pop hits",
    "rock": "classic rock",
    "hiphop": "hip hop",
    "mixed": "top hits",
    "movies": "movie soundtrack",
    "britpop": "britpop",
  };
  const term = themeMap[theme] || theme;
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&limit=50&entity=song`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    const withPreviews = data.results.filter((t) => t.previewUrl);
    // Shuffle and take `count`
    const shuffled = withPreviews.sort(() => Math.random() - 0.5).slice(0, count);
    return shuffled.map((t) => ({
      trackName: t.trackName,
      artistName: t.artistName,
      albumArt: t.artworkUrl100,
      previewUrl: t.previewUrl,
    }));
  } catch (e) {
    console.error("iTunes fetch failed:", e);
    return [];
  }
}

// ─────────────────────────────────────────
// CLAUDE — Generate AI trivia question
// ─────────────────────────────────────────

async function generateQuestion(theme, round, difficulty) {
  const difficultyLabel = difficulty === 1 ? "easy" : difficulty === 2 ? "medium" : "hard";
  const prompt = `You are generating a music trivia question for a pub game called Music Mayhem.
Theme: ${theme}
Round: ${round}
Difficulty: ${difficultyLabel}

Respond ONLY with valid JSON, no markdown, no preamble:
{
  "question": "...",
  "options": ["A: ...", "B: ...", "C: ...", "D: ..."],
  "correct": "A",
  "funFact": "A short fun fact about the answer (1-2 sentences, conversational)"
}

Make the question genuinely interesting. Wrong answers should be believable. Fun fact should be surprising or funny.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await res.json();
    const text = data.content[0].text.replace(/```json|```/g, "").trim();
    return JSON.parse(text);
  } catch (e) {
    console.error("Claude question gen failed:", e);
    return {
      question: "Which artist released the best-selling album of all time?",
      options: ["A: Michael Jackson", "B: The Beatles", "C: Adele", "D: Elvis Presley"],
      correct: "A",
      funFact: "Thriller has sold over 70 million copies worldwide — still unbeaten.",
    };
  }
}

// ─────────────────────────────────────────
// WEBSOCKET — Real-time game engine
// ─────────────────────────────────────────

wss.on("connection", (ws) => {
  ws.id = Math.random().toString(36).slice(2);

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { type, gameCode, payload } = msg;

    // ── JOIN ──────────────────────────────
    if (type === "join") {
      if (!games[gameCode]) return ws.send(err("Game not found"));

      const g = games[gameCode];

      if (payload.role === "tv") {
        g.tvSocket = ws;
        ws.gameCode = gameCode;
        ws.role = "tv";
        broadcast(g, { type: "tv-connected" });
        return;
      }

      // Player join
      g.players[ws.id] = { name: payload.name, score: 0, buzzed: false };
      ws.gameCode = gameCode;
      ws.role = "player";
      ws.playerName = payload.name;

      ws.send(json({ type: "joined", playerId: ws.id, name: payload.name }));
      broadcastTV(g, { type: "player-joined", players: g.players });
      broadcastPlayers(g, { type: "player-list", players: g.players });
    }

    // ── HOST CREATES GAME ─────────────────
    if (type === "create") {
      const code = payload.code || Math.random().toString(36).slice(2, 8).toUpperCase();
      const theme = payload.theme || "mixed";
      games[code] = createGame(code, theme);
      const g = games[code];

      // Pre-fetch iTunes clips
      g.clips = await fetchItunesClips(theme, 15);

      ws.gameCode = code;
      ws.role = "host";
      g.hostSocket = ws;

      ws.send(json({ type: "created", gameCode: code, theme, clipCount: g.clips.length }));
    }

    // ── HOST STARTS GAME ──────────────────
    if (type === "start") {
      const g = games[gameCode];
      if (!g) return;
      startNextRound(g);
    }

    // ── BUZZER ────────────────────────────
    if (type === "buzz") {
      const g = games[gameCode];
      if (!g || g.phase !== "clip" || g.buzzerWinner) return;

      g.buzzerWinner = { id: ws.id, name: g.players[ws.id]?.name };
      broadcast(g, { type: "buzzed", winner: g.buzzerWinner });

      // Lock everyone else out
      broadcastPlayers(g, { type: "buzz-locked", winnerId: ws.id });
    }

    // ── CLIP ANSWER (after buzz) ──────────
    if (type === "clip-answer") {
      const g = games[gameCode];
      if (!g || !g.buzzerWinner || g.buzzerWinner.id !== ws.id) return;

      const { artist, title } = payload;
      const correct = g.currentClip;
      let points = 0;

      const artistMatch = artist?.toLowerCase().includes(correct.artistName.toLowerCase()) ||
                          correct.artistName.toLowerCase().includes(artist?.toLowerCase());
      const titleMatch = title?.toLowerCase().includes(correct.trackName.toLowerCase()) ||
                         correct.trackName.toLowerCase().includes(title?.toLowerCase());

      if (artistMatch && titleMatch) points = 100;
      else if (artistMatch || titleMatch) points = 50;

      if (points > 0) g.players[ws.id].score += points;

      broadcast(g, {
        type: "clip-result",
        correct,
        answeredBy: g.buzzerWinner.name,
        points,
        scores: g.players,
      });

      setTimeout(() => startNextRound(g), 5000);
    }

    // ── AI QUESTION ANSWER ────────────────
    if (type === "answer") {
      const g = games[gameCode];
      if (!g || g.phase !== "ai-question") return;
      if (g.answers[ws.id]) return; // already answered

      g.answers[ws.id] = payload.answer;

      // Check if all players answered
      const total = Object.keys(g.players).length;
      const answered = Object.keys(g.answers).length;

      ws.send(json({ type: "answer-received" }));

      if (answered >= total) revealAnswers(g);
    }

    // ── NEXT ROUND (host trigger) ─────────
    if (type === "next") {
      const g = games[gameCode];
      if (g) startNextRound(g);
    }
  });

  ws.on("close", () => {
    const g = games[ws.gameCode];
    if (!g) return;
    if (ws.role === "player") {
      delete g.players[ws.id];
      broadcastTV(g, { type: "player-list", players: g.players });
    }
  });
});

// ─────────────────────────────────────────
// GAME FLOW
// ─────────────────────────────────────────

async function startNextRound(g) {
  g.round++;
  if (g.round > g.totalRounds) return endGame(g);

  const roundType = g.roundSchedule[g.round - 1] || "mayhem";
  g.buzzerWinner = null;
  g.answers = {};

  // Reset player buzzed state
  Object.values(g.players).forEach((p) => (p.buzzed = false));

  if (roundType === "clip" || roundType === "mayhem") {
    await playClipRound(g, roundType === "mayhem");
  } else {
    await playAIRound(g);
  }
}

async function playClipRound(g, isMayhem = false) {
  const clip = g.clips[g.clipIndex++] || g.clips[0];
  g.currentClip = clip;
  g.phase = "clip";

  const clipDuration = isMayhem ? 5000 : 15000; // 5s mayhem, 15s normal

  broadcast(g, {
    type: "clip-round",
    round: g.round,
    total: g.totalRounds,
    clip: { previewUrl: clip.previewUrl, albumArt: clip.albumArt },
    duration: clipDuration,
    isMayhem,
  });

  // Auto-reveal if no buzzer in time
  g.timer = setTimeout(() => {
    if (!g.buzzerWinner) {
      broadcast(g, {
        type: "clip-result",
        correct: g.currentClip,
        answeredBy: null,
        points: 0,
        scores: g.players,
      });
      setTimeout(() => startNextRound(g), 4000);
    }
  }, clipDuration + 2000);
}

async function playAIRound(g) {
  g.phase = "ai-question";
  const difficulty = Math.ceil(g.round / 2); // gets harder each round

  const q = await generateQuestion(g.theme, g.round, difficulty);
  g.currentQuestion = q;

  broadcast(g, {
    type: "ai-question",
    round: g.round,
    total: g.totalRounds,
    question: q.question,
    options: q.options,
    timeLimit: 20,
  });

  // Auto-reveal after time limit
  g.timer = setTimeout(() => revealAnswers(g), 22000);
}

function revealAnswers(g) {
  clearTimeout(g.timer);
  const q = g.currentQuestion;
  if (!q) return;

  // Award points
  Object.entries(g.answers).forEach(([id, answer]) => {
    if (answer === q.correct && g.players[id]) {
      g.players[id].score += 75;
    }
  });

  broadcast(g, {
    type: "reveal",
    correct: q.correct,
    funFact: q.funFact,
    answers: g.answers,
    scores: g.players,
  });

  setTimeout(() => startNextRound(g), 7000);
}

function endGame(g) {
  g.phase = "end";
  const sorted = Object.entries(g.players)
    .map(([id, p]) => ({ id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);

  broadcast(g, { type: "game-over", leaderboard: sorted });
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

function broadcast(g, data) {
  broadcastTV(g, data);
  broadcastPlayers(g, data);
}

function broadcastTV(g, data) {
  if (g.tvSocket?.readyState === 1) g.tvSocket.send(json(data));
}

function broadcastPlayers(g, data) {
  wss.clients.forEach((ws) => {
    if (ws.gameCode === g.gameCode && ws.role === "player" && ws.readyState === 1) {
      ws.send(json(data));
    }
  });
}

function json(data) { return JSON.stringify(data); }
function err(msg) { return json({ type: "error", message: msg }); }

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`🎤 Music Mayhem server running on port ${PORT}`);
});
