
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3500;
const DB_URL = process.env.DB_URL;

const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || "";
const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:3600";

// Middleware
app.use(cors());
app.use(express.json());

/* =========================
ALARM SCHEMA
========================= */
const AlarmSchema = new mongoose.Schema({
type: String,
message: String,
severity: String,
timestamp: { type: Date, default: Date.now },
acknowledged: { type: Boolean, default: false }
});
const Alarm = mongoose.model("Alarm", AlarmSchema);



/* =========================
IN-MEMORY STATE
========================= */
let grinderState = {
forward: false,
reverse: false,
jam: false,
LOWLEVEL: false,
autoMode: false,
manualMode: false,
gatewayConnected: false,
lastReset: null,
timestamp: null
};
let lastGatewayPing = 0;
let pendingReset = { active: false, timestamp: null };


/* =========================
AUTH (User)
========================= */
function signToken(payload) {
return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "8h" });
}
function requireUserAuth(req, res, next) {
try {
const auth = req.headers.authorization;
if (!auth || !auth.startsWith("Bearer ")) {
return res.status(401).json({ success: false, message: "Missing token" });
}
const token = auth.split(" ")[1];
const decoded = jwt.verify(token, process.env.JWT_SECRET);
req.user = decoded;
next();
} catch (err) {
return res.status(401).json({ success: false, message: "Invalid/expired token" });
}
}
app.post("/api/login", (req, res) => {
const { username, password } = req.body;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;

if (!ADMIN_USER || !ADMIN_PASS || !process.env.JWT_SECRET) {
return res.status(500).json({
success: false,
message: "Server auth not configured (check .env)"
});
}
if (username === ADMIN_USER && password === ADMIN_PASS) {
const token = signToken({ username, role: "admin" });
return res.json({
success: true,
message: "Login successful",
token,
user: { username, role: "admin" }
});
}
return res.status(401).json({ success: false, message: "Invalid credentials" });
});

/* =========================
AUTH (Gateway)
========================= */
function requireGatewayAuth(req, res, next) {
const auth = req.headers.authorization || "";
console.log("Gateway auth attempt:", auth ? "Has auth header" : "No auth header");
if (!auth.startsWith("Bearer ")) {
console.log("Gateway auth failed: No Bearer prefix");
return res.status(401).json({ error: "Unauthorized" });
}
const token = auth.split(" ")[1];
console.log("Gateway token received:", token.substring(0, 10) + "...");
console.log("Expected token:", GATEWAY_TOKEN.substring(0, 10) + "...");
console.log("Token match:", token === GATEWAY_TOKEN);
if (token !== GATEWAY_TOKEN) {
console.log("Gateway auth failed: Token mismatch");
return res.status(403).json({ error: "Forbidden" });
}
console.log("Gateway auth successful");
return next();
}


/* =========================
GATEWAY INGEST ROUTES
========================= */
app.post("/api/gateway/state", requireGatewayAuth, (req, res) => {
console.log("Gateway state received:", req.body);
grinderState = { ...req.body, timestamp: new Date().toISOString() };
lastGatewayPing = Date.now();
grinderState.gatewayConnected = true;
console.log("Gateway state updated, lastGatewayPing:", lastGatewayPing);
return res.json({ success: true });
});


app.post("/api/gateway/alarm", requireGatewayAuth, async (req, res) => {
try {
const { type, message, severity } = req.body;
const alarm = new Alarm({ type, message, severity });
await alarm.save();
return res.json({ success: true });
} catch (err) {
return res.status(500).json({ success: false, error: err.message });
}
});

/* =========================
USER API ROUTES
========================= */
app.get("/api/grinder-data", requireUserAuth, (req, res) => {
const connected = Date.now() - lastGatewayPing < 15000;
res.json({
...grinderState,
gatewayConnected: connected
});
});

app.post("/api/reset", requireUserAuth, async (req, res) => {
try {
pendingReset = { active: true, timestamp: new Date().toISOString() };
const alarm = new Alarm({ type: "System Reset", message: "Grinder system reset requested", severity: "low" });
await alarm.save();

return res.json({ success: true, message: "Reset queued. Gateway will process shortly.", timestamp: pendingReset.timestamp });
} catch (err) {
return res.status(500).json({ success: false, error: err.message });
}
});

app.get("/api/reset-status", requireGatewayAuth, (req, res) => {
res.json({ ...pendingReset });
});



app.get("/api/alarms", requireUserAuth, async (req, res) => {

try {
const alarms = await Alarm.find().sort({ timestamp: -1 }).limit(50);
res.json(alarms);
} catch (error) {
res.status(500).json({ error: "Failed to fetch alarms" });
}
});

app.get("/api/alarms/count", requireUserAuth, async (req, res) => {
try {
const count = await Alarm.countDocuments({ acknowledged: false });
res.json({ count });
} catch (error) {
res.status(500).json({ error: "Failed to count alarms" });
}
});

app.patch("/api/alarms/:id", requireUserAuth, async (req, res) => {
try {
const alarm = await Alarm.findByIdAndUpdate(req.params.id, { acknowledged: true }, { new: true });
res.json(alarm);
} catch (error) {
res.status(500).json({ error: "Failed to update alarm" });
}
});

app.post("/api/alarms/acknowledge-all", requireUserAuth, async (req, res) => {
try {
await Alarm.updateMany({ acknowledged: false }, { acknowledged: true });
res.json({ success: true, message: "All alarms acknowledged" });
} catch (error) {
res.status(500).json({ success: false, error: error.message });
}
});

app.delete("/api/alarms/:id", requireUserAuth, async (req, res) => {
try {
await Alarm.findByIdAndDelete(req.params.id);
res.json({ success: true });
} catch (error) {
res.status(500).json({ error: "Failed to delete alarm" });
}
});

/* =========================
CONNECT TO DATABASE 
========================= */
mongoose
.connect(DB_URL)
.then(() => {
console.log("Connected to MongoDB");
app.listen(PORT, () => {
console.log(`Backend running on port ${PORT}`);
console.log(`API available at http://localhost:${PORT}/api/grinder-data`);
});
})
.catch((err) => {
console.error("MongoDB connection error:", err);
console.log("Starting server without database...");
app.listen(PORT, () => {
console.log(`Backend running on port ${PORT} (No DB)`);
});
});
