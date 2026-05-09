require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ==============================
// 🔐 FIREBASE ADMIN INIT
// ==============================
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

// ==============================
// 🗄️ SUPABASE INIT
// ==============================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ==============================
// 🛡️ CORS
// ==============================
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-local-date"
  ]
}));

app.options("*", cors());

app.use(express.json());

// ==============================
// 🚦 RATE LIMITER
// ==============================
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 50
}));

// ==============================
// 🔐 VERIFY FIREBASE USER
// ==============================
async function verifyUser(req, res, next) {

  try {

    const token =
      req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        error: "Unauthorized"
      });
    }

    const decoded =
      await admin.auth().verifyIdToken(token);

    req.user = decoded;

    next();

  } catch (error) {

    console.error("AUTH ERROR:");
    console.error(error);

    return res.status(401).json({
      error: "Unauthorized"
    });
  }
}

// ==============================
// 🧠 HELPERS
// ==============================
function getTodayStr(req) {

  const clientDate =
    req.headers["x-local-date"];

  if (clientDate) {
    return clientDate;
  }

  const now = new Date();

  const year = now.getFullYear();
  const month = String(now.getMonth() + 1)
    .padStart(2, "0");

  const day = String(now.getDate())
    .padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function calculateLevel(xp) {
  return Math.floor(xp / 100) + 1;
}

// ==============================
// ❤️ HEALTH
// ==============================
app.get("/", (req, res) => {

  res.json({
    status: "OneDay Backend Running 🚀"
  });
});

app.get("/health", (req, res) => {

  res.json({
    status: "ok"
  });
});

// ==============================
// 👤 GET USER
// ==============================
app.get("/api/user", verifyUser, async (req, res) => {

  try {

    const { uid, name } = req.user;

    let { data: user, error } =
      await supabase
        .from("users")
        .select("*")
        .eq("id", uid)
        .single();

    if (error && error.code !== "PGRST116") {

      console.error("SUPABASE FETCH ERROR:");
      console.error(error);

      throw error;
    }

    // ==============================
    // CREATE USER
    // ==============================
    if (!user) {

      const safeName =
        name ||
        req.user.email?.split("@")[0] ||
        "Guest";

      const newUserPayload = {
        id: uid,
        name: safeName,
        xp: 0,
        streak: 0,
        level: 1,
        levelProgress: 0,
        freeze_until: null,
        lastActiveDate: new Date().toISOString()
      };

      console.log("CREATING USER:");
      console.log(newUserPayload);

      const { error: insertError } =
        await supabase
          .from("users")
          .insert([newUserPayload]);

      if (insertError) {

        console.error("SUPABASE INSERT ERROR:");
        console.error(insertError);

        return res.status(500).json({
          error: "Database insert failed",
          details: insertError.message
        });
      }

      const {
        data: createdUser,
        error: createdUserError
      } = await supabase
        .from("users")
        .select("*")
        .eq("id", uid)
        .single();

      if (createdUserError) {

        console.error("FETCH CREATED USER ERROR:");
        console.error(createdUserError);

        return res.status(500).json({
          error: "Failed to fetch created user"
        });
      }

      return res.json(createdUser);
    }

    // ==============================
    // STREAK RESET
    // ==============================
    const now = new Date();

    let shouldReset = false;

    if (user.lastActiveDate) {

      const last =
        new Date(user.lastActiveDate);

      if (!isNaN(last.getTime())) {

        const diffHours =
          (now.getTime() - last.getTime()) /
          (1000 * 60 * 60);

        const isFrozen =
          user.freeze_until &&
          new Date(user.freeze_until) > now;

        if (diffHours > 48 && !isFrozen) {
          shouldReset = true;
        }
      }
    }

    if (shouldReset) {

      const { error: resetError } =
        await supabase
          .from("users")
          .update({
            streak: 0
          })
          .eq("id", uid);

      if (resetError) {

        console.error("STREAK RESET ERROR:");
        console.error(resetError);

        throw resetError;
      }

      user.streak = 0;
    }

    return res.json({
      id: user.id,
      name: user.name,
      xp: user.xp,
      streak: user.streak,
      level: user.level,
      levelProgress: user.levelProgress,
      freeze_until: user.freeze_until,
      lastActiveDate: user.lastActiveDate
    });

  } catch (error) {

    console.error("GET USER ERROR:");
    console.error(error);

    return res.status(500).json({
      error: "User failed",
      details: error?.message
    });
  }
});

// ==============================
// 📊 GET HABITS
// ==============================
app.get("/api/habits", verifyUser, async (req, res) => {

  try {

    const { uid } = req.user;

    const today = getTodayStr(req);

    const {
      data: habits,
      error: habitsError
    } = await supabase
      .from("habits")
      .select("*")
      .eq("userId", uid);

    if (habitsError) {
      throw habitsError;
    }

    const {
      data: completions,
      error: completionsError
    } = await supabase
      .from("completions")
      .select("habitId")
      .eq("userId", uid)
      .eq("date", today);

    if (completionsError) {
      throw completionsError;
    }

    const completedSet = new Set(
      (completions || []).map(c => c.habitId)
    );

    const result =
      (habits || []).map(h => ({
        id: h.id,
        name: h.name,
        completedToday:
          completedSet.has(h.id)
      }));

    return res.json(result);

  } catch (error) {

    console.error("GET HABITS ERROR:");
    console.error(error);

    return res.status(500).json({
      error: "Habits failed"
    });
  }
});

// ==============================
// ➕ ADD HABIT
// ==============================
app.post("/api/habit", verifyUser, async (req, res) => {

  try {

    const { uid } = req.user;
    const { name } = req.body;

    if (!name || !name.trim()) {

      return res.status(400).json({
        error: "Habit name required"
      });
    }

    const { error } =
      await supabase
        .from("habits")
        .insert([{
          userId: uid,
          name: name.trim(),
          createdAt:
            new Date().toISOString()
        }]);

    if (error) {
      throw error;
    }

    return res.json({
      success: true
    });

  } catch (error) {

    console.error("ADD HABIT ERROR:");
    console.error(error);

    return res.status(500).json({
      error: "Add failed"
    });
  }
});

// ==============================
// ✅ COMPLETE HABIT
// ==============================
app.post("/api/complete", verifyUser, async (req, res) => {

  try {

    const { uid } = req.user;
    const { habit_id } = req.body;

    if (!habit_id) {

      return res.status(400).json({
        error: "habit_id required"
      });
    }

    const today = getTodayStr(req);

    // ==============================
    // DUPLICATE CHECK
    // ==============================
    const {
      data: existing,
      error: existingError
    } = await supabase
      .from("completions")
      .select("id")
      .eq("habitId", habit_id)
      .eq("userId", uid)
      .eq("date", today)
      .maybeSingle();

    if (existingError) {
      throw existingError;
    }

    if (existing) {

      return res.status(400).json({
        error:
          "Habit already completed today"
      });
    }

    // ==============================
    // INSERT COMPLETION
    // ==============================
    const { error: completionError } =
      await supabase
        .from("completions")
        .insert([{
          habitId: habit_id,
          userId: uid,
          date: today,
          createdAt:
            new Date().toISOString()
        }]);

    if (completionError) {
      throw completionError;
    }

    // ==============================
    // GET TODAY COMPLETIONS
    // ==============================
    const {
      data: todayCompletions,
      error: todayError
    } = await supabase
      .from("completions")
      .select("id")
      .eq("userId", uid)
      .eq("date", today);

    if (todayError) {
      throw todayError;
    }

    const isFirstToday =
      (todayCompletions || []).length === 1;

    // ==============================
    // FETCH USER
    // ==============================
    const {
      data: user,
      error: userError
    } = await supabase
      .from("users")
      .select("*")
      .eq("id", uid)
      .single();

    if (userError) {
      throw userError;
    }

    let xp = (user.xp || 0) + 10;
    let streak = user.streak || 0;

    if (isFirstToday) {
      streak += 1;
    }

    // ==============================
    // UPDATE USER
    // ==============================
    const { error: updateError } =
      await supabase
        .from("users")
        .update({
          xp,
          streak,
          level: calculateLevel(xp),
          levelProgress: xp % 100,
          lastActiveDate:
            new Date().toISOString()
        })
        .eq("id", uid);

    if (updateError) {
      throw updateError;
    }

    return res.json({
      success: true
    });

  } catch (error) {

    console.error("COMPLETE ERROR:");
    console.error(error);

    return res.status(500).json({
      error: "Complete failed"
    });
  }
});

// ==============================
// ❄️ FREEZE
// ==============================
app.post("/api/freeze", verifyUser, async (req, res) => {

  try {

    const { uid } = req.user;
    const { days } = req.body;

    if (!days || days <= 0) {

      return res.status(400).json({
        error: "Invalid freeze duration"
      });
    }

    const freezeUntil = new Date();

    freezeUntil.setDate(
      freezeUntil.getDate() + Number(days)
    );

    const { error } =
      await supabase
        .from("users")
        .update({
          freeze_until:
            freezeUntil.toISOString()
        })
        .eq("id", uid);

    if (error) {
      throw error;
    }

    return res.json({
      success: true
    });

  } catch (error) {

    console.error("FREEZE ERROR:");
    console.error(error);

    return res.status(500).json({
      error: "Freeze failed"
    });
  }
});

// ==============================
// 🧠 CHAT
// ==============================
app.post("/api/chat", verifyUser, async (req, res) => {

  try {

    const { uid } = req.user;
    const { message } = req.body;

    if (!message || !message.trim()) {

      return res.status(400).json({
        error: "Message required"
      });
    }

    // ==============================
    // STORE USER MESSAGE
    // ==============================
    const {
      error: insertUserMessageError
    } = await supabase
      .from("chats")
      .insert([{
        user_id: uid,
        role: "user",
        message: message.trim(),
        created_at:
          new Date().toISOString()
      }]);

    if (insertUserMessageError) {
      throw insertUserMessageError;
    }

    // ==============================
    // GET USER STREAK
    // ==============================
    const {
      data: user,
      error: userError
    } = await supabase
      .from("users")
      .select("streak")
      .eq("id", uid)
      .single();

    if (userError) {
      throw userError;
    }

    // ==============================
    // GET CHAT HISTORY
    // ==============================
    const {
      data: history,
      error: historyError
    } = await supabase
      .from("chats")
      .select("role, message, created_at")
      .eq("user_id", uid)
      .order("created_at", {
        ascending: false
      })
      .limit(10);

    if (historyError) {
      throw historyError;
    }

    const orderedHistory =
      (history || []).reverse();

    // ==============================
    // SYSTEM PROMPT
    // ==============================
    const systemPrompt = `
You are OneDay AI Coach.

User streak: ${user.streak}

Rules:
- Short replies
- No emojis
- No fluff
- Premium tone
- Emotionally intense
- Focus on discipline
- One day at a time

If streak >= 7:
→ Be strict
→ Elite
→ Aggressive motivation

If streak < 7:
→ Be firm
→ Motivating
→ Supportive
`;

    const messages = [
      {
        role: "system",
        content: systemPrompt
      },
      ...orderedHistory.map(chat => ({
        role: chat.role,
        content: chat.message
      }))
    ];

    // ==============================
    // OPENROUTER API
    // ==============================
    const aiRes = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          model:
            "openai/gpt-3.5-turbo",
          messages
        })
      }
    );

    const aiData = await aiRes.json();

    console.log("OPENROUTER RESPONSE:");
    console.log(
      JSON.stringify(aiData, null, 2)
    );

    const reply =
      aiData?.choices?.[0]?.message?.content ||
      "Stay consistent.";

    // ==============================
    // STORE AI MESSAGE
    // ==============================
    const {
      error: insertAssistantError
    } = await supabase
      .from("chats")
      .insert([{
        user_id: uid,
        role: "assistant",
        message: reply,
        created_at:
          new Date().toISOString()
      }]);

    if (insertAssistantError) {
      throw insertAssistantError;
    }

    return res.json({
      reply
    });

  } catch (error) {

    console.error("CHAT ERROR:");
    console.error(error);

    return res.status(500).json({
      error: "Chat failed"
    });
  }
});

// ==============================
// 🚀 START SERVER
// ==============================
const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log(
    `OneDay backend running on port ${PORT} 🚀`
  );
});
