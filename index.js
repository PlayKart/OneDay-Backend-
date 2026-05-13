require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ==============================
// FIREBASE ADMIN
// ==============================
if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
  console.warn("WARNING: Missing Firebase Admin environment variables.");
} else {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}

// ==============================
// SUPABASE
// ==============================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ==============================
// MIDDLEWARE
// ==============================
// CRITICAL FIX: allow custom headers so frontend doesn't get blocked
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-local-date"]
}));

app.use(express.json());

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100
}));

// ==============================
// HELPERS
// ==============================
function getToday(req) {
  return (
    req.headers["x-local-date"] ||
    new Date().toISOString().split("T")[0]
  );
}

function calculateLevel(xp) {
  return Math.floor(xp / 100) + 1;
}

function calculateLevelProgress(xp) {
  return xp % 100;
}

// CRITICAL FIX: Safe date logic (avoiding timezone bugs)
function calculateStreak(lastActiveDate, streak, today, freezeUntil) {
  if (!lastActiveDate) {
    return 1;
  }

  const last = new Date(lastActiveDate);
  const current = new Date(today);
  const yesterday = new Date(current);
  yesterday.setDate(current.getDate() - 1);

  const lastStr = last.toISOString().split("T")[0];
  const todayStr = current.toISOString().split("T")[0];
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  // SAME DAY
  if (lastStr === todayStr) {
    return streak;
  }

  // YESTERDAY
  if (lastStr === yesterdayStr) {
    return streak + 1;
  }

  // FREEZE ACTIVE
  if (freezeUntil) {
    const freezeDate = new Date(freezeUntil);
    const freezeStr = freezeDate.toISOString().split("T")[0];
    if (freezeStr >= yesterdayStr) {
      return streak + 1;
    }
  }

  // LOST STREAK
  return 1;
}

// ==============================
// AUTH MIDDLEWARE
// ==============================
async function authMiddleware(req, res, next) {
  try {
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!admin.apps.length) {
      throw new Error("Firebase Admin not configured on server.");
    }

    const decoded = await admin.auth().verifyIdToken(token);
    const { uid, email, name } = decoded;

    req.user = { uid, email, name };

    const { data: existingUser, error } = await supabase
      .from("users")
      .select("*")
      .eq("id", uid)
      .maybeSingle();

    if (error) throw error;

    if (!existingUser) {
      const { error: insertError } = await supabase
        .from("users")
        .insert([{
          id: uid,
          email: email || null,
          name: name || "Guest",
          xp: 0,
          streak: 0,
          level: 1,
          levelProgress: 0
        }]);

      if (insertError) throw insertError;
    }

    next();
  } catch (error) {
    console.error("AUTH ERROR:", error);
    return res.status(401).json({ error: "Unauthorized" });
  }
}

// ==============================
// HEALTH CHECK
// ==============================
app.get("/", (req, res) => {
  return res.json({
    status: "OneDay Backend Running",
    version: "1.0.0"
  });
});

// ==============================
// GET USER
// ==============================
app.get("/api/user", authMiddleware, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("id", req.user.uid)
      .single();

    if (error) throw error;

    return res.json(user);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to fetch user" });
  }
});

// ==============================
// GET HABITS
// ==============================
app.get("/api/habits", authMiddleware, async (req, res) => {
  try {
    const today = getToday(req);

    const { data: habits, error: habitsError } = await supabase
      .from("habits")
      .select("*")
      .eq("user_id", req.user.uid);

    if (habitsError) throw habitsError;

    const { data: completions, error: completionError } = await supabase
      .from("habit_completions")
      .select("habit_id")
      .eq("user_id", req.user.uid)
      .eq("completed_date", today);

    if (completionError) throw completionError;

    // CRITICAL FIX: Fallbacks to empty arrays `[]` to prevent `.map` crash
    const completedSet = new Set((completions || []).map(c => c.habit_id));

    const result = (habits || []).map(h => ({
      id: h.id,
      userId: h.user_id,
      name: h.name,
      difficulty: h.difficulty,
      notes: h.notes,
      repeatType: h.repeatType,
      customDays: h.customDays,
      createdAt: h.created_at,
      completedToday: completedSet.has(h.id)
    }));

    return res.json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to fetch habits" });
  }
});

// ==============================
// ADD HABIT
// ==============================
app.post("/api/habit", authMiddleware, async (req, res) => {
  try {
    const { name, repeatType, customDays, difficulty, notes } = req.body;

    const { error } = await supabase
      .from("habits")
      .insert([{
        user_id: req.user.uid,
        name,
        repeatType: repeatType || "every_day",
        customDays: customDays || [],
        difficulty: difficulty || "Medium",
        notes: notes || ""
      }]);

    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to create habit" });
  }
});

// ==============================
// UPDATE HABIT
// ==============================
app.put("/api/habit", authMiddleware, async (req, res) => {
  try {
    const { habit_id, name, repeatType, customDays, difficulty, notes } = req.body;

    const { error } = await supabase
      .from("habits")
      .update({
        name,
        repeatType,
        customDays,
        difficulty,
        notes
      })
      .eq("id", habit_id)
      .eq("user_id", req.user.uid);

    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to update habit" });
  }
});

// ==============================
// DELETE HABIT
// ==============================
app.delete("/api/habit/:id", authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from("habits")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", req.user.uid);

    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to delete habit" });
  }
});

// ==============================
// COMPLETE HABIT
// ==============================
app.post("/api/complete", authMiddleware, async (req, res) => {
  try {
    const { habit_id } = req.body;
    const today = getToday(req);

    const { error: completionError } = await supabase
      .from("habit_completions")
      .insert([{
        habit_id,
        user_id: req.user.uid,
        completed_date: today
      }]);

    if (completionError) throw completionError;

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("id", req.user.uid)
      .single();

    if (userError) throw userError;

    const xp = (user.xp || 0) + 10;

    const streak = calculateStreak(
      user.lastActiveDate,
      user.streak || 0,
      today,
      user.freeze_until
    );

    const { error: updateError } = await supabase
      .from("users")
      .update({
        xp,
        streak,
        level: calculateLevel(xp),
        levelProgress: calculateLevelProgress(xp),
        lastActiveDate: today
      })
      .eq("id", req.user.uid);

    if (updateError) throw updateError;
    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to complete habit" });
  }
});

// ==============================
// UNDO
// ==============================
app.post("/api/undo", authMiddleware, async (req, res) => {
  try {
    const { habit_id } = req.body;
    const today = getToday(req);

    const { error: deleteError } = await supabase
      .from("habit_completions")
      .delete()
      .eq("habit_id", habit_id)
      .eq("user_id", req.user.uid)
      .eq("completed_date", today);

    if (deleteError) throw deleteError;

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("id", req.user.uid)
      .single();

    if (userError) throw userError;

    const xp = Math.max(0, (user.xp || 0) - 10);

    const { error: updateError } = await supabase
      .from("users")
      .update({
        xp,
        level: calculateLevel(xp),
        levelProgress: calculateLevelProgress(xp)
      })
      .eq("id", req.user.uid);

    if (updateError) throw updateError;
    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to undo" });
  }
});

// ==============================
// FREEZE
// ==============================
app.post("/api/freeze", authMiddleware, async (req, res) => {
  try {
    const { days } = req.body;
    const freezeDate = new Date();
    freezeDate.setDate(freezeDate.getDate() + Number(days));

    const { error } = await supabase
      .from("users")
      .update({
        freeze_until: freezeDate.toISOString()
      })
      .eq("id", req.user.uid);

    if (error) throw error;

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to freeze streak" });
  }
});

// ==============================
// RESET
// ==============================
app.post("/api/reset", authMiddleware, async (req, res) => {
  try {
    await supabase
      .from("habit_completions")
      .delete()
      .eq("user_id", req.user.uid);

    const { error } = await supabase
      .from("users")
      .update({
        xp: 0,
        streak: 0,
        level: 1,
        levelProgress: 0
      })
      .eq("id", req.user.uid);

    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to reset" });
  }
});

// ==============================
// DELETE ACCOUNT
// ==============================
app.delete("/api/account", authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from("users")
      .delete()
      .eq("id", req.user.uid);

    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to delete account" });
  }
});

// ==============================
// AI CHAT (OPENROUTER)
// ==============================
app.post("/api/chat", authMiddleware, async (req, res) => {
  try {
    const { message } = req.body;

    const { data: habits } = await supabase
      .from("habits")
      .select("*")
      .eq("user_id", req.user.uid);

    const { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("id", req.user.uid)
      .single();

    const prompt = `
You are OneDay AI Coach.

You speak like David Goggins.

Be intense.
Be brutally honest.
Be elite.

User streak: ${user?.streak || 0}
User XP: ${user?.xp || 0}
Habit count: ${habits?.length || 0}
User message: ${message}

Respond briefly.
No emojis.
`;

    if (!process.env.OPENROUTER_API_KEY) {
      return res.json({ reply: "Stop waiting for motivation and execute. (API Key missing)" });
    }

    const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openai/gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }]
      })
    });

    const aiData = await aiRes.json();
    const reply = aiData?.choices?.[0]?.message?.content || "Stop waiting for motivation and execute.";

    return res.json({ reply });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Chat failed" });
  }
});

// ==============================
// START SERVER
// ==============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OneDay backend running on port ${PORT}`);
});
