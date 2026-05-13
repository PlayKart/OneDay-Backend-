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
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

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
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100
}));

// ==============================
// HELPERS
// ==============================
function getToday(req) {
  return req.headers["x-local-date"] || new Date().toISOString().split("T")[0];
}

function calculateLevel(xp) {
  return Math.floor(xp / 100) + 1;
}

function calculateLevelProgress(xp) {
  return xp % 100;
}

function calculateStreak(lastActiveDate, streak, today, freezeUntil) {
  if (!lastActiveDate) return 1;

  const last = new Date(lastActiveDate);
  const current = new Date(today);
  const yesterday = new Date(current);
  yesterday.setDate(yesterday.getDate() - 1);

  const freeze = freezeUntil ? new Date(freezeUntil) : null;

  if (last.toDateString() === current.toDateString()) return streak;
  if (last.toDateString() === yesterday.toDateString()) return streak + 1;
  if (freeze && freeze >= yesterday) return streak + 1;

  return 1;
}

// Supabase ID columns are 'text', so we manually generate string IDs for inserts
function generateId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// ==============================
// AUTH MIDDLEWARE
// ==============================
async function authMiddleware(req, res, next) {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Unauthorized" });

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
  return res.json({ status: "OneDay Backend Running", version: "1.0.0" });
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

    // Using exact schema names: userId, repeat_type, custom_days
    const { data: habits, error: habitsError } = await supabase
      .from("habits")
      .select("*")
      .eq("userId", req.user.uid);

    if (habitsError) throw habitsError;

    // Using exact schema name: completions, habitId, userId, date
    const { data: completions, error: completionError } = await supabase
      .from("completions")
      .select("habitId")
      .eq("userId", req.user.uid)
      .eq("date", today);

    if (completionError) throw completionError;

    const completedSet = new Set((completions || []).map(c => c.habitId));

    const result = (habits || []).map(h => ({
      id: h.id,
      userId: h.userId,
      name: h.name,
      difficulty: h.difficulty,
      notes: h.notes,
      repeatType: h.repeat_type, // Map backend 'repeat_type' to frontend 'repeatType'
      customDays: h.custom_days, // Map backend 'custom_days' to frontend 'customDays'
      createdAt: h.createdAt,
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
    
    const newHabit = {
      id: generateId(),
      userId: req.user.uid,
      name,
      repeat_type: repeatType || "every_day",
      custom_days: customDays || [],
      difficulty: difficulty || "Medium",
      notes: notes || "",
      createdAt: new Date().toISOString()
    };

    const { error } = await supabase.from("habits").insert([newHabit]);
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
    const { habit_id, id, name, repeatType, customDays, difficulty, notes } = req.body;
    const targetId = habit_id || id; 

    const { error } = await supabase
      .from("habits")
      .update({
        name,
        repeat_type: repeatType,
        custom_days: customDays,
        difficulty,
        notes
      })
      .eq("id", targetId)
      .eq("userId", req.user.uid);

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
      .eq("userId", req.user.uid);

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
    const targetId = req.body.habit_id || req.body.id;
    const today = getToday(req);

    // 1. Check if already completed today
    const { data: existingCompletion } = await supabase
      .from("completions")
      .select("*")
      .eq("habitId", targetId)
      .eq("userId", req.user.uid)
      .eq("date", today)
      .maybeSingle();

    if (existingCompletion) {
       return res.json({ success: true }); // already done
    }

    const { error: completionError } = await supabase
      .from("completions")
      .insert([{
        id: generateId(),
        habitId: targetId,
        userId: req.user.uid,
        date: today,
        createdAt: new Date().toISOString()
      }]);

    if (completionError) throw completionError;

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("id", req.user.uid)
      .single();

    if (userError) throw userError;

    const xp = (user.xp || 0) + 10;
    const streak = calculateStreak(user.lastActiveDate, user.streak || 0, today, user.freeze_until);

    const { error: updateError } = await supabase
      .from("users")
      .update({
        xp,
        streak,
        level: calculateLevel(xp),
        levelProgress: calculateLevelProgress(xp),
        lastActiveDate: new Date().toISOString() // Set exactly to ISO Timestamp
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
    const targetId = req.body.habit_id || req.body.id;
    const today = getToday(req);

    const { error: deleteError } = await supabase
      .from("completions")
      .delete()
      .eq("habitId", targetId)
      .eq("userId", req.user.uid)
      .eq("date", today);

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
      .update({ freeze_until: freezeDate.toISOString() })
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
    await supabase.from("completions").delete().eq("userId", req.user.uid);

    const { error } = await supabase
      .from("users")
      .update({ xp: 0, streak: 0, level: 1, levelProgress: 0 })
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
    const { error } = await supabase.from("users").delete().eq("id", req.user.uid);
    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to delete account" });
  }
});

// ==============================
// AI CHAT (OPENROUTER) & HISTORY
// ==============================
app.get("/api/chats", authMiddleware, async (req, res) => {
  try {
    const { data: messages, error } = await supabase
      .from("chats")
      .select("*")
      .eq("user_id", req.user.uid)
      .order("created_at", { ascending: true });

    if (error) throw error;
    return res.json(messages);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to load chat history" });
  }
});

app.post("/api/chat", authMiddleware, async (req, res) => {
  try {
    const { message } = req.body;
    
    // Save user message
    await supabase.from("chats").insert([{
      id: generateId(),
      user_id: req.user.uid,
      role: "user",
      message: message,
      created_at: new Date().toISOString()
    }]);

    const { data: habits } = await supabase.from("habits").select("*").eq("userId", req.user.uid);
    const { data: user } = await supabase.from("users").select("*").eq("id", req.user.uid).single();

    const prompt = `
You are OneDay AI Coach.
You speak like David Goggins.
Be intense. Be brutally honest. Be elite.

User streak: ${user?.streak || 0}
User XP: ${user?.xp || 0}
Habit count: ${habits?.length || 0}

User message: ${message}

Respond briefly. No emojis.
`;

    let reply = "Stop waiting for motivation. Execute.";
    try {
      const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "openai/gpt-3.5-turbo",
          messages: [{ role: "user", content: prompt }]
        })
      });

      const aiData = await aiRes.json();
      if (aiData?.choices?.[0]?.message?.content) {
        reply = aiData.choices[0].message.content;
      }
    } catch (e) {
      console.log("AI fetch failed, falling back to default.", e);
    }

    // Save AI message
    await supabase.from("chats").insert([{
      id: generateId(),
      user_id: req.user.uid,
      role: "assistant",
      message: reply,
      created_at: new Date().toISOString()
    }]);

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
