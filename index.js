require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
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
// ✅ MIDDLEWARE
// ==============================
app.use(cors());
app.use(bodyParser.json());

// ==============================
// 🧠 COACH PERSONALITY
// ==============================
const COACH = `
You are a high-performance personal growth coach.

- Short, sharp, powerful
- Mix discipline + motivation
- Never long paragraphs

Push when strong
Support when low
Call out excuses
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
// 🔥 XP SYSTEM
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
// 🧠 MEMORY BUILDER
// ==============================
function buildMemory(user) {
  const last = user.reflections?.slice(-5) || [];

  return `
User: ${user.name}
Streak: ${user.streak}
XP: ${user.xp}

Habits:
${JSON.stringify(user.habits || [])}

Reflections:
${last.map(r => "- " + r.text).join("\n")}
`;
}

// ==============================
// 🧠 MOOD SYSTEM
// ==============================
function moodInstruction(user) {
  const last = user.reflections?.slice(-1)[0];
  if (!last) return "";

  switch (last.mood) {
    case "stressed": return "User stressed → calm tone";
    case "low": return "User low → supportive";
    case "happy": return "User strong → push harder";
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
// 🔐 GOOGLE LOGIN
// ==============================
app.post("/google-login", async (req, res) => {
  try {
    const { token } = req.body;

    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: CLIENT_ID,
    });

    const payload = ticket.getPayload();

    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("email", payload.email)
      .single();

    if (error || !user) {
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
    res.status(500).json({ success: false });
  }
});

// ==============================
// 📥 GET USER
// ==============================
app.get("/user", async (req, res) => {
  try {
    const payload = await verifyUser(req);

    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("email", payload.email)
      .single();

    if (error) throw error;

    res.json(data);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "User fetch failed" });
  }
});

// ==============================
// 🧠 AI CHAT WITH MEMORY
// ==============================
app.post("/chat", async (req, res) => {
  try {
    const payload = await verifyUser(req);
    const { message } = req.body;

    // 🔥 Save user message
    await supabase.from("chats").insert([
      {
        user_id: payload.email,
        role: "user",
        message
      }
    ]);

    // 🧠 Get last 10 messages
    const { data: history } = await supabase
      .from("chats")
      .select("role, message")
      .eq("user_id", payload.email)
      .order("created_at", { ascending: false })
      .limit(10);

    const messages = (history || []).reverse().map(m => ({
      role: m.role,
      content: m.message
    }));

    // 🧠 Get user data
    const { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("email", payload.email)
      .single();

    const memory = buildMemory(user);
    const mood = moodInstruction(user);

    // 🤖 AI CALL
    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: COACH },
          { role: "system", content: memory },
          { role: "system", content: mood },
          ...messages
        ]
      })
    });

    const data = await aiRes.json();
    const reply = data.choices?.[0]?.message?.content || "No response";

    // 🔥 Save AI reply
    await supabase.from("chats").insert([
      {
        user_id: payload.email,
        role: "assistant",
        message: reply
      }
    ]);

    res.json({ reply });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI failed" });
  }
});

// ==============================
// 🚀 START SERVER
// ==============================
app.listen(3000, () => {
  console.log("Server running on port 3000 🚀");
});
