require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenAI } = require("@google/genai");

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
// GEMINI AI
// ==============================
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// ==============================
// MIDDLEWARE
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

// ==============================
// FIXED STREAK LOGIC
// ==============================
function calculateStreak(
  lastActiveDate,
  streak,
  today,
  freezeUntil
) {
  // FIRST COMPLETION EVER
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

  // ALREADY COMPLETED TODAY
  if (lastStr === todayStr) {
    return streak;
  }

  // NORMAL CONTINUATION
  if (lastStr === yesterdayStr) {
    return streak + 1;
  }

  // ==============================
  // FREEZE PROTECTION
  // ==============================
  if (freezeUntil) {
    const freezeDate = new Date(freezeUntil);
    const freezeStr = freezeDate.toISOString().split("T")[0];

    // FREEZE STILL VALID
    if (freezeStr >= yesterdayStr) {
      return streak + 1;
    }
  }

  // RESET STREAK
  return 1;
}

// ==============================
// AUTH MIDDLEWARE
// ==============================
async function authMiddleware(req, res, next) {
  try {
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        error: "Unauthorized"
      });
    }

    const decoded = await admin.auth().verifyIdToken(token);

    const {
      uid,
      email,
      name
    } = decoded;

    req.user = {
      uid,
      email
    };

    let {
      data: existingUser
    } = await supabase
      .from("users")
      .select("*")
      .eq("id", uid)
      .maybeSingle();

    if (!existingUser) {
      const {
        error: insertError
      } = await supabase
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

      if (insertError) {
        throw insertError;
      }
    }

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
// HEALTH
// ==============================
app.get("/", (req, res) => {
  res.json({
    status: "OneDay Backend Running"
  });
});

// ==============================
// GET USER
// ==============================
app.get("/api/user", authMiddleware, async (req, res) => {
  try {
    const {
      data: user,
      error
    } = await supabase
      .from("users")
      .select("*")
      .eq("id", req.user.uid)
      .single();

    if (error) {
      throw error;
    }

    return res.json(user);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "User fetch failed"
    });
  }
});

// ==============================
// GET HABITS
// ==============================
app.get("/api/habits", authMiddleware, async (req, res) => {
  try {
    const today = getToday(req);

    const {
      data: habits,
      error: habitsError
    } = await supabase
      .from("habits")
      .select("*")
      .eq("user_id", req.user.uid);

    if (habitsError) {
      throw habitsError;
    }

    const {
      data: completions,
      error: completionError
    } = await supabase
      .from("habit_completions")
      .select("habit_id")
      .eq("user_id", req.user.uid)
      .eq("completed_date", today);

    if (completionError) {
      throw completionError;
    }

    const completedSet = new Set(
      completions.map(c => c.habit_id)
    );

    const result = habits.map(habit => ({
      id: habit.id,
      userId: habit.user_id,
      name: habit.name,
      createdAt: habit.created_at,
      difficulty: habit.difficulty,
      notes: habit.notes,
      repeatType: habit.repeatType,
      customDays: habit.customDays,
      completedToday: completedSet.has(habit.id)
    }));

    return res.json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Habits fetch failed"
    });
  }
});

// ==============================
// ADD HABIT
// ==============================
app.post("/api/habit", authMiddleware, async (req, res) => {
  try {
    const {
      name,
      repeatType,
      customDays,
      difficulty,
      notes
    } = req.body;

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

    if (error) {
      throw error;
    }

    return res.json({
      success: true
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Habit creation failed"
    });
  }
});

// ==============================
// UPDATE HABIT
// ==============================
app.put("/api/habit", authMiddleware, async (req, res) => {
  try {
    const {
      habit_id,
      name,
      repeatType,
      customDays,
      difficulty,
      notes
    } = req.body;

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

    if (error) {
      throw error;
    }

    return res.json({
      success: true
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Habit update failed"
    });
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

    if (error) {
      throw error;
    }

    return res.json({
      success: true
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Habit delete failed"
    });
  }
});

// ==============================
// COMPLETE HABIT
// ==============================
app.post("/api/complete", authMiddleware, async (req, res) => {
  try {
    const {
      habit_id
    } = req.body;

    const today = getToday(req);

    // ==============================
    // INSERT COMPLETION
    // ==============================
    const {
      error: completionError
    } = await supabase
      .from("habit_completions")
      .insert([{
        habit_id,
        user_id: req.user.uid,
        completed_date: today
      }]);

    if (completionError) {
      throw completionError;
    }

    // ==============================
    // FETCH USER
    // ==============================
    const {
      data: user
    } = await supabase
      .from("users")
      .select("*")
      .eq("id", req.user.uid)
      .single();

    const xp = (user.xp || 0) + 10;

    // ==============================
    // FIXED STREAK CALL
    // ==============================
    const streak = calculateStreak(
      user.lastActiveDate,
      user.streak || 0,
      today,
      user.freeze_until
    );

    // ==============================
    // UPDATE USER
    // ==============================
    const {
      error: updateError
    } = await supabase
      .from("users")
      .update({
        xp,
        streak,
        level: calculateLevel(xp),
        levelProgress: calculateLevelProgress(xp),
        lastActiveDate: today
      })
      .eq("id", req.user.uid);

    if (updateError) {
      throw updateError;
    }

    return res.json({
      success: true
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Complete failed"
    });
  }
});

// ==============================
// UNDO HABIT
// ==============================
app.post("/api/undo", authMiddleware, async (req, res) => {
  try {
    const {
      habit_id
    } = req.body;

    const today = getToday(req);

    const {
      error: deleteError
    } = await supabase
      .from("habit_completions")
      .delete()
      .eq("habit_id", habit_id)
      .eq("user_id", req.user.uid)
      .eq("completed_date", today);

    if (deleteError) {
      throw deleteError;
    }

    const {
      data: user
    } = await supabase
      .from("users")
      .select("*")
      .eq("id", req.user.uid)
      .single();

    const xp = Math.max(0, (user.xp || 0) - 10);

    const {
      error: updateError
    } = await supabase
      .from("users")
      .update({
        xp,
        level: calculateLevel(xp),
        levelProgress: calculateLevelProgress(xp)
      })
      .eq("id", req.user.uid);

    if (updateError) {
      throw updateError;
    }

    return res.json({
      success: true
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Undo failed"
    });
  }
});

// ==============================
// FREEZE
// ==============================
app.post("/api/freeze", authMiddleware, async (req, res) => {
  try {
    const {
      days
    } = req.body;

    const freezeDate = new Date();
    freezeDate.setDate(freezeDate.getDate() + Number(days));

    const { error } = await supabase
      .from("users")
      .update({
        freeze_until: freezeDate.toISOString()
      })
      .eq("id", req.user.uid);

    if (error) {
      throw error;
    }

    return res.json({
      success: true
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Freeze failed"
    });
  }
});

// ==============================
// RESET ACCOUNT
// ==============================
app.post("/api/reset", authMiddleware, async (req, res) => {
  try {
    await supabase
      .from("habit_completions")
      .delete()
      .eq("user_id", req.user.uid);

    await supabase
      .from("users")
      .update({
        xp: 0,
        streak: 0,
        level: 1,
        levelProgress: 0
      })
      .eq("id", req.user.uid);

    return res.json({
      success: true
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Reset failed"
    });
  }
});

// ==============================
// DELETE ACCOUNT
// ==============================
app.delete("/api/account", authMiddleware, async (req, res) => {
  try {
    await supabase
      .from("users")
      .delete()
      .eq("id", req.user.uid);

    return res.json({
      success: true
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Account deletion failed"
    });
  }
});

// ==============================
// AI CHAT
// ==============================
app.post("/api/chat", authMiddleware, async (req, res) => {
  try {
    const {
      message
    } = req.body;

    const {
      data: user
    } = await supabase
      .from("users")
      .select("*")
      .eq("id", req.user.uid)
      .single();

    const {
      data: habits
    } = await supabase
      .from("habits")
      .select("*")
      .eq("user_id", req.user.uid);

    const prompt = `
You are OneDay AI Coach.
You are intense.
You are motivational.
You speak like David Goggins.

User streak:
${user.streak}

User XP:
${user.xp}

Habit count:
${habits.length}

User message:
${message}

Respond in under 80 words.
`;

    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt
    });

    const reply = response.text || "Stop waiting to feel motivated. Execute.";

    return res.json({
      reply
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Chat failed"
    });
  }
});

// ==============================
// START SERVER
// ==============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
