require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const rateLimit = require("express-rate-limit");
const { OAuth2Client } = require("google-auth-library");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ==============================
// 🔐 CONFIG
// ==============================
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const client = new OAuth2Client(CLIENT_ID);

// ==============================
// 🛡️ MIDDLEWARE
// ==============================
app.use(cors());
app.use(bodyParser.json());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30
});
app.use(limiter);

// ==============================
// 🧠 COACH
// ==============================
const COACH = `
You are a high-performance personal growth coach.
Short, sharp, powerful.
Push hard. No excuses.
`;

// ==============================
// 🔐 VERIFY USER
// ==============================
async function verifyUser(req) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) throw new Error("No token");

  const ticket = await client.verifyIdToken({
    idToken: token,
    audience: CLIENT_ID,
  });

  return ticket.getPayload();
}

// ==============================
// 🔥 XP + STREAK SYSTEM
// ==============================
function calculateLevel(xp) {
  return Math.floor(xp / 100) + 1;
}

function getProgress(xp) {
  return xp % 100;
}

function updateProgress(user) {
  const today = new Date().toDateString();
  const last = user.lastActiveDate
    ? new Date(user.lastActiveDate).toDateString()
    : null;

  let streak = user.streak || 0;
  let xp = user.xp || 0;

  if (last === today) {
    xp += 10;
  } else {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    if (last === yesterday.toDateString()) {
      streak += 1;
    } else {
      streak = 1;
    }

    xp += 10;
  }

  return {
    streak,
    xp,
    level: calculateLevel(xp),
    levelProgress: getProgress(xp),
    lastActiveDate: new Date(),
  };
}

// ==============================
// 🧠 MEMORY
// ==============================
function buildMemory(user) {
  const last = user.reflections?.slice(-5) || [];

  return `
User: ${user.name}
Streak: ${user.streak}
XP: ${user.xp}

Reflections:
${last.map(r => "- " + r.text).join("\n")}
`;
}

// ==============================
// 🧠 MOOD
// ==============================
function moodInstruction(user) {
  const last = user.reflections?.slice(-1)[0];
  if (!last) return "";

  switch (last.mood) {
    case "stressed": return "User stressed → calm";
    case "low": return "User low → support";
    case "happy": return "User strong → push";
    default: return "";
  }
}

// ==============================
// 🎯 TEST
// ==============================
app.get("/", (req, res) => {
  res.send("Backend Running 🚀");
});

// ==============================
// 🔐 LOGIN
// ==============================
app.post("/google-login", async (req, res) => {
  try {
    const { token } = req.body;

    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: CLIENT_ID,
    });

    const payload = ticket.getPayload();

    const { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("email", payload.email)
      .single();

    if (!user) {
      await supabase.from("users").insert([
        {
          email: payload.email,
          name: payload.name,
          xp: 0,
          streak: 0,
          level: 1,
          levelProgress: 0,
          habits: [],
          reflections: [],
        }
      ]);
    }

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

// ==============================
// 📥 GET USER (WITH AUTO FREEZE)
// ==============================
app.get("/user", async (req, res) => {
  try {
    const payload = await verifyUser(req);

    const { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("email", payload.email)
      .single();

    // 🔥 AUTO FREEZE
    const last = user.lastActiveDate
      ? new Date(user.lastActiveDate)
      : null;

    if (last) {
      const diff = (Date.now() - last.getTime()) / (1000 * 60 * 60 * 24);

      if (diff >= 2) {
        const freezeUntil = new Date();
        freezeUntil.setDate(freezeUntil.getDate() + 2);

        await supabase
          .from("users")
          .update({ freeze_until: freezeUntil })
          .eq("email", payload.email);
      }
    }

    res.json(user);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "User fetch failed" });
  }
});

// ==============================
// 📥 HABITS
// ==============================
app.get("/habits", async (req, res) => {
  try {
    const payload = await verifyUser(req);

    const { data } = await supabase
      .from("habits")
      .select("*")
      .eq("user_id", payload.email);

    res.json(data);

  } catch (err) {
    res.status(500).json({ error: "Failed to fetch habits" });
  }
});

// ==============================
// ➕ ADD HABIT
// ==============================
app.post("/habit", async (req, res) => {
  try {
    const payload = await verifyUser(req);
    const { name } = req.body;

    await supabase.from("habits").insert([
      { name, user_id: payload.email }
    ]);

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: "Add habit failed" });
  }
});

// ==============================
// ✅ COMPLETE HABIT
// ==============================
app.post("/complete", async (req, res) => {
  try {
    const payload = await verifyUser(req);
    const { habit_id } = req.body;

    const today = new Date().toISOString().split("T")[0];

    await supabase.from("completions").insert([
      { habit_id, user_id: payload.email, date: today }
    ]);

    const { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("email", payload.email)
      .single();

    const updated = updateProgress(user);

    await supabase
      .from("users")
      .update(updated)
      .eq("email", payload.email);

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: "Complete failed" });
  }
});

// ==============================
// ❄️ FREEZE
// ==============================
app.post("/freeze", async (req, res) => {
  try {
    const payload = await verifyUser(req);
    const { days } = req.body;

    const date = new Date();
    date.setDate(date.getDate() + days);

    await supabase
      .from("users")
      .update({ freeze_until: date })
      .eq("email", payload.email);

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: "Freeze failed" });
  }
});

// ==============================
// 🧠 CHAT
// ==============================
app.post("/chat", async (req, res) => {
  try {
    const payload = await verifyUser(req);
    const { message } = req.body;

    await supabase.from("chats").insert([
      { user_id: payload.email, role: "user", message }
    ]);

    const { data: history } = await supabase
      .from("chats")
      .select("role, message")
      .eq("user_id", payload.email)
      .order("created_at", { ascending: false })
      .limit(10);

    const { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("email", payload.email)
      .single();

    const messages = (history || []).reverse().map(m => ({
      role: m.role,
      content: m.message
    }));

    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: COACH },
          { role: "system", content: buildMemory(user) },
          { role: "system", content: moodInstruction(user) },
          ...messages
        ]
      })
    });

    const data = await aiRes.json();
    const reply = data?.choices?.[0]?.message?.content || "Try again";

    await supabase.from("chats").insert([
      { user_id: payload.email, role: "assistant", message: reply }
    ]);

    res.json({ reply });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Chat failed" });
  }
});

// ==============================
// 🚀 START
// ==============================
app.listen(3000, () => {
  console.log("Server running on port 3000 🚀");
});
