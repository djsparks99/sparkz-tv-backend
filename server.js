import express from 'express';
import cors from 'cors';
import bcryptjs from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import fetch from 'node-fetch';
import pg from 'pg';
import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 17817;

// ============ CONFIG ============
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const MUX_TOKEN_ID = process.env.MUX_TOKEN_ID || '9549ad5f-e145-4c54-bc19-6b264bbd984a';
const MUX_TOKEN_SECRET = process.env.MUX_TOKEN_SECRET || 'QvRrDNSZB6hGwcICOpS9713d44JRvNKs80qtVfiLHKsu6JRCjFs1EWG9IdUDYhEY9Ao6t2jS9x5';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_jduErl0mfc7T@ep-red-flower-aidjj6te-pooler.c-4.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

// ============ DATABASE ============
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ============ MIDDLEWARE ============
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 } });

// ============ UTILITIES ============
const muxAuth = Buffer.from(`${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}`).toString('base64');

async function callMuxAPI(method, endpoint, body = null) {
  try {
    const options = {
      method,
      headers: {
        'Authorization': `Basic ${muxAuth}`,
        'Content-Type': 'application/json'
      }
    };
    if (body) options.body = JSON.stringify(body);
    
    const response = await fetch(`https://api.mux.com${endpoint}`, options);
    const data = await response.json();
    return { success: response.ok, data, status: response.status };
  } catch (error) {
    console.error('MUX API error:', error);
    return { success: false, error: error.message };
  }
}

function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Invalid token' });
  
  req.userId = decoded.userId;
  next();
};

// ============ ROUTES ============

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Sign up
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, djName } = req.body;
    
    const existingUser = await pool.query('SELECT id FROM sparkz_users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    
    const hashedPassword = await bcryptjs.hash(password, 10);
    
    // Create MUX live stream
    const muxResponse = await callMuxAPI('POST', '/video/v1/live-streams', {
      playback_policy: ['public'],
      new_asset_settings: { playback_policy: ['public'] },
      latency_mode: 'low'
    });
    
    if (!muxResponse.success) {
      return res.status(500).json({ error: 'Failed to create stream' });
    }
    
    const streamKey = muxResponse.data.data.stream_key;
    const muxStreamId = muxResponse.data.data.id;
    const playbackId = muxResponse.data.data.playback_ids?.[0]?.id;
    
    const result = await pool.query(
      `INSERT INTO sparkz_users (email, password, dj_name, stream_key, mux_stream_id, playback_id) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, dj_name`,
      [email, hashedPassword, djName, streamKey, muxStreamId, playbackId]
    );
    
    const token = generateToken(result.rows[0].id);
    res.json({ token, user: result.rows[0] });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Log in
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const result = await pool.query('SELECT * FROM sparkz_users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const user = result.rows[0];
    const passwordMatch = await bcryptjs.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const token = generateToken(user.id);
    res.json({ token, user: { id: user.id, email: user.email, dj_name: user.dj_name } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get user profile
app.get('/api/users/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, dj_name, bio, profile_pic, stream_key, mux_stream_id, playback_id FROM sparkz_users WHERE id = $1', [req.params.userId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update user profile
app.put('/api/users/:userId', authMiddleware, async (req, res) => {
  try {
    const { djName, bio } = req.body;
    const result = await pool.query(
      'UPDATE sparkz_users SET dj_name = $1, bio = $2 WHERE id = $3 RETURNING id, dj_name, bio',
      [djName, bio, req.params.userId]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upload profile picture
app.post('/api/users/:userId/profile-pic', authMiddleware, upload.single('profilePic'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const cropped = await sharp(req.file.buffer)
      .resize(200, 200, { fit: 'cover' })
      .toBuffer();
    
    const base64 = cropped.toString('base64');
    const imageData = `data:image/jpeg;base64,${base64}`;
    
    await pool.query('UPDATE sparkz_users SET profile_pic = $1 WHERE id = $2', [imageData, req.params.userId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get stream key
app.get('/api/users/:userId/stream-key', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT stream_key FROM sparkz_users WHERE id = $1', [req.params.userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ streamKey: result.rows[0].stream_key });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Regenerate stream key
app.post('/api/users/:userId/regenerate-key', authMiddleware, async (req, res) => {
  try {
    const userResult = await pool.query('SELECT mux_stream_id FROM sparkz_users WHERE id = $1', [req.params.userId]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    
    const muxStreamId = userResult.rows[0].mux_stream_id;
    const muxResponse = await callMuxAPI('POST', `/video/v1/live-streams/${muxStreamId}/reset-stream-key`);
    
    if (!muxResponse.success) {
      return res.status(500).json({ error: 'Failed to reset stream key' });
    }
    
    const newStreamKey = muxResponse.data.data.stream_key;
    await pool.query('UPDATE sparkz_users SET stream_key = $1 WHERE id = $2', [newStreamKey, req.params.userId]);
    
    res.json({ streamKey: newStreamKey });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create stream
app.post('/api/streams', authMiddleware, async (req, res) => {
  try {
    const { name, genre } = req.body;
    const result = await pool.query(
      `INSERT INTO sparkz_streams (user_id, name, genre, is_live) 
       VALUES ($1, $2, $3, true) RETURNING id, name, genre, created_at`,
      [req.userId, name, genre]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get active streams
app.get('/api/streams/active', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.name, s.genre, s.created_at, u.id as user_id, u.dj_name, u.profile_pic, u.playback_id 
       FROM sparkz_streams s 
       JOIN sparkz_users u ON s.user_id = u.id 
       WHERE s.is_live = true 
       ORDER BY s.created_at DESC`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// End stream
app.post('/api/streams/:streamId/end', authMiddleware, async (req, res) => {
  try {
    await pool.query('UPDATE sparkz_streams SET is_live = false WHERE id = $1', [req.params.streamId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Follow user
app.post('/api/users/:userId/follow', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO sparkz_follows (follower_id, following_id) VALUES ($1, $2) 
       ON CONFLICT DO NOTHING`,
      [req.userId, req.params.userId]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get followers
app.get('/api/users/:userId/followers', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.dj_name, u.profile_pic FROM sparkz_follows f 
       JOIN sparkz_users u ON f.follower_id = u.id 
       WHERE f.following_id = $1`,
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get chat messages
app.get('/api/streams/:streamId/chat', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.id, m.message, m.created_at, u.id as user_id, u.dj_name, u.profile_pic 
       FROM sparkz_chat_messages m 
       JOIN sparkz_users u ON m.user_id = u.id 
       WHERE m.stream_id = $1 
       ORDER BY m.created_at ASC LIMIT 100`,
      [req.params.streamId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send chat message
app.post('/api/streams/:streamId/chat', authMiddleware, async (req, res) => {
  try {
    const { message } = req.body;
    const result = await pool.query(
      `INSERT INTO sparkz_chat_messages (stream_id, user_id, message) 
       VALUES ($1, $2, $3) RETURNING id, message, created_at`,
      [req.params.streamId, req.userId, message]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get schedules
app.get('/api/users/:userId/schedule', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, day, time, show_name FROM sparkz_schedules WHERE user_id = $1 ORDER BY day, time',
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add schedule
app.post('/api/users/:userId/schedule', authMiddleware, async (req, res) => {
  try {
    const { day, time, showName } = req.body;
    const result = await pool.query(
      `INSERT INTO sparkz_schedules (user_id, day, time, show_name) 
       VALUES ($1, $2, $3, $4) RETURNING id, day, time, show_name`,
      [req.params.userId, day, time, showName]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete schedule
app.delete('/api/schedules/:scheduleId', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM sparkz_schedules WHERE id = $1', [req.params.scheduleId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ ERROR HANDLING ============
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: err.message });
});

// ============ START SERVER ============
app.listen(PORT, () => {
  console.log(`✅ Server running on ${PORT}`);
});
