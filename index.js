require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");
const { createClient } = require("@supabase/supabase-js");

// ==============================
// 🚀 INIT
// ==============================
const app = express();

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
app.disable("x-powered-by");

app.use(cors({
  origin: ["http://localhost:5173", process.env.FRONTEND_URL],
  credentials: true
}));

app.use(express.json());

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60
}));

// ==============================
// 🔐 AUTH
// ==============================
async function verifyUser(req, res, next) {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "No token" });

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
function today() {
  return new Date().toISOString().split("T")[0];
}

function calculateLevel(xp) {
  return Math.floor(xp / 100) + 1;
}

// ==============================
// ❤️ HEALTH
// ==============================
app.get("/health", (_, res) => res.json({ status: "ok" }));

// ==============================
// 👤 USER
// ==============================
app.get("/api/user", verifyUser, async (req, res) => {
  try {
    const { uid, email, name } = req.user;

    let { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("id", uid)
      .single();

    if (!user) {
      await supabase.from("users").insert([{
        id: uid,
        email,
        name,
        xp: 0,
        level: 1,
        level_progress: 0,
        streak: 0,
        freeze_until: null,
        last_active_date: new Date()
      }]);

      const { data: newUser } = await supabase
        .from("users")
        .select("*")
        .eq("id", uid)
        .single();

      return res.json(newUser);
    }

    // 🔥 STREAK RESET
    const now = new Date();
    const last = new Date(user.last_active_date);
    const diff = (now - last) / (1000 * 60 * 60 * 24);

    const frozen = user.freeze_until && new Date(user.freeze_until) > now;

    if (diff >= 2 && !frozen) {
      await supabase.from("users").update({ streak: 0 }).eq("id", uid);
      user.streak = 0;
    }

    res.json(user);

  } catch (err) {
    res.status(500).json({ error: "User fetch failed" });
  }
});

// ==============================
// 📊 HABITS
// ==============================
app.get("/api/habits", verifyUser, async (req, res) => {
  try {
    const { uid } = req.user;

    const { data: habits } = await supabase
      .from("habits")
      .select("*")
      .eq("user_id", uid);

    const { data: completions } = await supabase
      .from("completions")
      .select("habit_id")
      .eq("user_id", uid)
      .eq("date", today());

    const set = new Set(completions.map(c => c.habit_id));

    res.json(habits.map(h => ({
      ...h,
      completedToday: set.has(h.id)
    })));

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

    if (!name) return res.status(400).json({ error: "Name required" });

    await supabase.from("habits").insert([{
      user_id: uid,
      name
    }]);

    res.json({ success: true });

  } catch {
    res.status(500).json({ error: "Add failed" });
  }
});

// ==============================
// ✅ COMPLETE
// ==============================
app.post("/api/complete", verifyUser, async (req, res) => {
  try {
    const { uid } = req.user;
    const { habit_id } = req.body;

    const todayDate = today();

    const { data: exists } = await supabase
      .from("completions")
      .select("id")
      .eq("habit_id", habit_id)
      .eq("user_id", uid)
      .eq("date", todayDate)
      .maybeSingle();

    if (exists) return res.json({ success: false });

    await supabase.from("completions").insert([{
      habit_id,
      user_id: uid,
      date: todayDate
    }]);

    const { data: todayList } = await supabase
      .from("completions")
      .select("*")
      .eq("user_id", uid)
      .eq("date", todayDate);

    const firstToday = todayList.length === 1;

    const { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("id", uid)
      .single();

    let xp = user.xp + 10;
    let streak = user.streak;

    if (firstToday) streak += 1;

    await supabase.from("users").update({
      xp,
      streak,
      level: calculateLevel(xp),
      level_progress: xp % 100,
      last_active_date: new Date()
    }).eq("id", uid);

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

    const until = new Date();
    until.setDate(until.getDate() + days);

    await supabase.from("users")
      .update({ freeze_until: until })
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

    const prompt =
      user.streak >= 7
        ? "Strict elite coach. Aggressive. No excuses."
        : "Firm and motivating coach.";

    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: message }
        ]
      })
    });

    const data = await aiRes.json();
    const reply = data?.choices?.[0]?.message?.content || "Stay consistent.";

    res.json({ reply });

  } catch {
    res.status(500).json({ error: "Chat failed" });
  }
});

// ==============================
// 🚀 START
// ==============================
app.listen(3000, () => {
  console.log("🚀 Backend running on port 3000");
});
