require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ==============================
// 🔐 INIT
// ==============================
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ==============================
// 🛡️ MIDDLEWARE
// ==============================
app.use(cors());
app.use(express.json());

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 50
}));

// ==============================
// 🔐 AUTH
// ==============================
async function verifyUser(req, res, next) {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) throw new Error();

    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;

    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
}

// ==============================
// 🧠 HELPERS
// ==============================
function todayStr() {
  return new Date().toISOString().split("T")[0];
}

function calculateLevel(xp) {
  return Math.floor(xp / 100) + 1;
}

// ==============================
// 🎯 HEALTH
// ==============================
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ==============================
// 👤 GET USER
// ==============================
app.get("/api/user", verifyUser, async (req, res) => {
  try {
    const { uid, email, name } = req.user;

    let { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("id", uid)
      .single();

    // CREATE USER IF NOT EXISTS
    if (!user) {
      await supabase.from("users").insert([{
        id: uid,
        name,
        xp: 0,
        streak: 0,
        level: 1,
        levelProgress: 0,
        freeze_until: null,
        lastActiveDate: new Date()
      }]);

      const { data: newUser } = await supabase
        .from("users")
        .select("*")
        .eq("id", uid)
        .single();

      return res.json(newUser);
    }

    // 🔥 STREAK RESET LOGIC (STRICT 48h)
    const now = new Date();
    const last = new Date(user.lastActiveDate);

    const diffHours = (now - last) / (1000 * 60 * 60);
    const isFrozen =
      user.freeze_until && new Date(user.freeze_until) > now;

    if (diffHours > 48 && !isFrozen) {
      await supabase
        .from("users")
        .update({ streak: 0 })
        .eq("id", uid);

      user.streak = 0;
    }

    res.json({
      name: user.name,
      xp: user.xp,
      streak: user.streak,
      level: user.level,
      levelProgress: user.levelProgress,
      freeze_until: user.freeze_until,
      lastActiveDate: user.lastActiveDate
    });

  } catch {
    res.status(500).json({ error: "User failed" });
  }
});

// ==============================
// 📊 GET HABITS
// ==============================
app.get("/api/habits", verifyUser, async (req, res) => {
  try {
    const { uid } = req.user;

    const { data: habits } = await supabase
      .from("habits")
      .select("*")
      .eq("userId", uid);

    const today = todayStr();

    const { data: completions } = await supabase
      .from("completions")
      .select("habitId")
      .eq("userId", uid)
      .eq("date", today);

    const completedSet = new Set(
      (completions || []).map(c => c.habitId)
    );

    const result = (habits || []).map(h => ({
      id: h.id,
      name: h.name,
      completedToday: completedSet.has(h.id)
    }));

    res.json(result);

  } catch {
    res.status(500).json({ error: "Habits failed" });
  }
});

// ==============================
// ➕ ADD HABIT
// ==============================
app.post("/api/habit", verifyUser, async (req, res) => {
  try {
    const { uid } = req.user;
    const { name } = req.body;

    await supabase.from("habits").insert([{
      userId: uid,
      name,
      createdAt: new Date()
    }]);

    res.json({ success: true });

  } catch {
    res.status(500).json({ error: "Add failed" });
  }
});

// ==============================
// ✅ COMPLETE HABIT
// ==============================
app.post("/api/complete", verifyUser, async (req, res) => {
  try {
    const { uid } = req.user;
    const { habit_id } = req.body;

    const today = todayStr();

    // ❌ DUPLICATE CHECK
    const { data: existing } = await supabase
      .from("completions")
      .select("id")
      .eq("habitId", habit_id)
      .eq("userId", uid)
      .eq("date", today)
      .maybeSingle();

    if (existing) {
      return res.json({ success: false });
    }

    // INSERT COMPLETION
    await supabase.from("completions").insert([{
      habitId: habit_id,
      userId: uid,
      date: today,
      createdAt: new Date()
    }]);

    // GET TODAY COMPLETIONS
    const { data: todayCompletions } = await supabase
      .from("completions")
      .select("*")
      .eq("userId", uid)
      .eq("date", today);

    const isFirstToday = todayCompletions.length === 1;

    const { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("id", uid)
      .single();

    let xp = user.xp + 10;
    let streak = user.streak;

    if (isFirstToday) {
      streak += 1;
    }

    await supabase
      .from("users")
      .update({
        xp,
        streak,
        level: calculateLevel(xp),
        levelProgress: xp % 100,
        lastActiveDate: new Date()
      })
      .eq("id", uid);

    res.json({ success: true });

  } catch {
    res.status(500).json({ error: "Complete failed" });
  }
});

// ==============================
// ❄️ FREEZE
// ==============================
app.post("/api/freeze", verifyUser, async (req, res) => {
  try {
    const { uid } = req.user;
    const { days } = req.body;

    const date = new Date();
    date.setDate(date.getDate() + days);

    await supabase
      .from("users")
      .update({ freeze_until: date })
      .eq("id", uid);

    res.json({ success: true });

  } catch {
    res.status(500).json({ error: "Freeze failed" });
  }
});

// ==============================
// 🧠 CHAT
// ==============================
app.post("/api/chat", verifyUser, async (req, res) => {
  try {
    const { uid } = req.user;
    const { message } = req.body;

    const { data: user } = await supabase
      .from("users")
      .select("streak")
      .eq("id", uid)
      .single();

    const systemPrompt = `
You are OneDay AI Coach.

User streak: ${user.streak}

Rules:
- Short replies
- No emojis
- No fluff

If streak >= 7:
→ Be strict, aggressive, elite

If streak < 7:
→ Be firm and motivating

Focus on discipline and daily action.
`;

    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message }
        ]
      })
    });

    const data = await aiRes.json();
    const reply =
      data?.choices?.[0]?.message?.content || "Stay consistent.";

    res.json({ reply });

  } catch {
    res.status(500).json({ error: "Chat failed" });
  }
});

// ==============================
// 🚀 START
// ==============================
app.listen(3000, () => {
  console.log("Backend running 🚀");
});
