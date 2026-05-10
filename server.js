require("dotenv").config();
const express = require("express");
const http = require("http");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const { createAdapter } = require("@socket.io/redis-adapter");
const { createClient } = require("redis");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;
const SOCKET_CORS_ORIGIN = process.env.SOCKET_CORS_ORIGIN || "*";
const REDIS_URL = process.env.REDIS_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const DRIVER_SEED_USERNAME = process.env.DRIVER_SEED_USERNAME;
const DRIVER_SEED_PASSWORD = process.env.DRIVER_SEED_PASSWORD;
const DRIVER_SEED_ROUTES = process.env.DRIVER_SEED_ROUTES;

if (!REDIS_URL) {
  console.error("REDIS_URL is required. Add it to your environment variables.");
  process.exit(1);
}

if (!JWT_SECRET) {
  console.error("JWT_SECRET is required. Add it to your environment variables.");
  process.exit(1);
}

// 1. --- MONGODB CONFIGURATION ---
const mongoURI = process.env.MONGO_URI;

if (!mongoURI) {
  console.error("MONGO_URI is required. Add it to your environment variables.");
  process.exit(1);
}

mongoose
  .connect(mongoURI)
  .then(async () => {
    console.log("Connected to MongoDB Atlas");
    // seedRoutes(); // Initialize database with some routes if empty
    await seedDriver();
  })
  .catch((err) => {
    console.error("MongoDB Error:", err);
    process.exit(1);
  });

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use(express.json());

// 2. --- ROUTE SCHEMA & MODEL ---
const RouteSchema = new mongoose.Schema({
  routeId: { type: String, required: true, unique: true },
  label: { type: String, required: true },
  startPoint: String,
  destination: String,
});

const Route = mongoose.model("Route", RouteSchema);

const DriverSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },
    passwordHash: { type: String, required: true },
    allowedRouteIds: [{ type: String, trim: true }],
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

const Driver = mongoose.model("Driver", DriverSchema);

// Helper function to add initial data to your database
async function seedRoutes() {
  const count = await Route.countDocuments();

  if (count === 0) {
    await Route.create([
      {
        routeId: "101",
        label: "Sakoli to Bhandara",
        startPoint: "Sakoli",
        destination: "Bhandara",
      },
      {
        routeId: "102",
        label: "Nagpur to Wardha",
        startPoint: "Nagpur",
        destination: "Wardha",
      },
      {
        routeId: "123",
        label: "Pune to Mumbai",
        startPoint: "Pune",
        destination: "Mumbai",
      },
    ]);
    console.log("Database Seeded: Initial routes added!");
  }
}

async function seedDriver() {
  if (!DRIVER_SEED_USERNAME || !DRIVER_SEED_PASSWORD) {
    return;
  }

  const existingDriver = await Driver.findOne({
    username: DRIVER_SEED_USERNAME,
  });

  if (existingDriver) {
    return;
  }

  const passwordHash = await bcrypt.hash(DRIVER_SEED_PASSWORD, 12);
  const allowedRouteIds = DRIVER_SEED_ROUTES
    ? DRIVER_SEED_ROUTES.split(",")
        .map((routeId) => routeId.trim())
        .filter(Boolean)
    : [];

  await Driver.create({
    username: DRIVER_SEED_USERNAME,
    passwordHash,
    allowedRouteIds,
  });

  console.log(`Seeded driver account: ${DRIVER_SEED_USERNAME}`);
}

function normalizeDriver(driver) {
  return {
    id: driver._id.toString(),
    username: driver.username,
    allowedRouteIds: driver.allowedRouteIds ?? [],
  };
}

function signDriverToken(driver) {
  const normalizedDriver = normalizeDriver(driver);

  return jwt.sign(
    {
      sub: normalizedDriver.id,
      username: normalizedDriver.username,
      allowedRouteIds: normalizedDriver.allowedRouteIds,
      role: "driver",
    },
    JWT_SECRET,
    { expiresIn: "12h" },
  );
}

app.post("/drivers/login", async (req, res) => {
  try {
    const username =
      typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const password =
      typeof req.body?.password === "string" ? req.body.password : "";

    if (!username || !password) {
      res.status(400).json({ error: "username and password are required" });
      return;
    }

    const driver = await Driver.findOne({ username, isActive: true });

    if (!driver) {
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }

    const isPasswordValid = await bcrypt.compare(password, driver.passwordHash);

    if (!isPasswordValid) {
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }

    res.json({
      token: signDriverToken(driver),
      driver: normalizeDriver(driver),
    });
  } catch (err) {
    console.error("Driver login failed:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// 3. --- SOCKET.IO SETUP ---
const io = new Server(server, {
  cors: { origin: SOCKET_CORS_ORIGIN, methods: ["GET", "POST"] },
  transports: ["websocket"],
});

const DEFAULT_BROADCAST_DURATION_MS = 60 * 60 * 1000;
const MIN_BROADCAST_DURATION_MS = 60 * 1000;
const MAX_BROADCAST_DURATION_MS = 12 * 60 * 60 * 1000;
const STALE_BUS_TTL_SECONDS = 90;
const MIN_LOCATION_UPDATE_INTERVAL_MS = 3000;

const redisClient = createClient({ url: REDIS_URL });
const redisSubscriber = redisClient.duplicate();

// Live tracking memory: { socketId: { routeId, label, socketId, lastLocation, expiresAt, timeoutId } }
const activeBuses = {};
const routeLiveCounts = new Map();
const lastLocationUpdateBySocket = new Map();

function latestLocationKey(routeId) {
  return `govbus:route:${routeId}:latest`;
}

function isRouteLive(routeId) {
  return (routeLiveCounts.get(routeId) ?? 0) > 0;
}

function addRouteLive(routeId) {
  routeLiveCounts.set(routeId, (routeLiveCounts.get(routeId) ?? 0) + 1);
}

function removeRouteLive(routeId) {
  const nextCount = (routeLiveCounts.get(routeId) ?? 0) - 1;

  if (nextCount > 0) {
    routeLiveCounts.set(routeId, nextCount);
  } else {
    routeLiveCounts.delete(routeId);
  }
}

function getDriverToken(socket, data) {
  const token =
    data?.driverAuthToken ||
    socket.handshake.auth?.driverToken ||
    socket.handshake.auth?.driverAuthToken ||
    socket.handshake.headers["x-driver-token"];

  return typeof token === "string" ? token : "";
}

async function validateDriver(socket, data, routeId) {
  const token = getDriverToken(socket, data);

  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded?.role !== "driver" || typeof decoded.sub !== "string") {
      return null;
    }

    const driver = await Driver.findOne({
      _id: decoded.sub,
      isActive: true,
    }).lean();

    if (!driver) {
      return null;
    }

    const allowedRouteIds = driver.allowedRouteIds ?? [];

    if (
      routeId &&
      allowedRouteIds.length > 0 &&
      !allowedRouteIds.includes(routeId)
    ) {
      return null;
    }

    return normalizeDriver(driver);
  } catch {
    return null;
  }
}

function emitBusStatus(eventName, bus, isLive) {
  io.emit(eventName, {
    routeId: bus.routeId,
    label: bus.label,
    isLive,
    expiresAt: bus.expiresAt,
  });
}

function getBusExpiry(data) {
  const now = Date.now();
  const requestedExpiresAt = Number(data?.expiresAt);
  const requestedDurationMinutes = Number(data?.durationMinutes);
  let expiresAt = now + DEFAULT_BROADCAST_DURATION_MS;

  if (Number.isFinite(requestedExpiresAt) && requestedExpiresAt > now) {
    expiresAt = requestedExpiresAt;
  } else if (
    Number.isFinite(requestedDurationMinutes) &&
    requestedDurationMinutes > 0
  ) {
    expiresAt = now + requestedDurationMinutes * 60 * 1000;
  }

  const durationMs = Math.min(
    Math.max(expiresAt - now, MIN_BROADCAST_DURATION_MS),
    MAX_BROADCAST_DURATION_MS,
  );

  return now + durationMs;
}

function clearBusTimer(bus) {
  if (bus?.timeoutId) {
    clearTimeout(bus.timeoutId);
    bus.timeoutId = null;
  }
}

function scheduleBusExpiry(socket, bus) {
  clearBusTimer(bus);

  bus.timeoutId = setTimeout(() => {
    const currentBus = activeBuses[socket.id];

    if (!currentBus || currentBus.expiresAt !== bus.expiresAt) {
      return;
    }

    socket.emit("bus_timer_expired", {
      routeId: currentBus.routeId,
      label: currentBus.label,
      expiresAt: currentBus.expiresAt,
    });

    removeBus(socket, "expired");
  }, Math.max(bus.expiresAt - Date.now(), 0));
}

function removeBus(socket, reason = "manual") {
  const bus = activeBuses[socket.id];

  if (!bus) {
    return;
  }

  clearBusTimer(bus);
  delete activeBuses[socket.id];
  lastLocationUpdateBySocket.delete(socket.id);
  socket.leave(bus.routeId);
  removeRouteLive(bus.routeId);

  console.log(`Bus ${bus.routeId} offline (${reason})`);

  if (!isRouteLive(bus.routeId)) {
    redisClient.del(latestLocationKey(bus.routeId)).catch((err) => {
      console.error("Redis latest location cleanup failed:", err);
    });
    emitBusStatus("bus_offline", bus, false);
  }
}

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // 4. --- FETCH BUS LIST FROM DB + LIVE STATUS ---
  socket.on("request_bus_list", async () => {
    try {
      const officialRoutes = await Route.find().lean();
      const latestLocations = officialRoutes.length
        ? await redisClient.mGet(
            officialRoutes.map((route) => latestLocationKey(route.routeId)),
          )
        : [];

      const list = officialRoutes.map((route, index) => ({
        routeId: route.routeId,
        label: route.label,
        isLive: Boolean(latestLocations[index]) || isRouteLive(route.routeId),
      }));

      socket.emit("active_buses_list", list);
    } catch (err) {
      console.error("Error fetching bus list:", err);
    }
  });

  socket.on("register_bus", async (data) => {
    const routeId =
      typeof data?.routeId === "string" ? data.routeId.trim() : "";
    const label = typeof data?.label === "string" ? data.label.trim() : "";

    if (!routeId || !label) {
      socket.emit("registration_error", "routeId and label are required");
      return;
    }

    const driver = await validateDriver(socket, data, routeId);

    if (!driver) {
      socket.emit("registration_error", "Driver validation failed");
      return;
    }

    const previousBus = activeBuses[socket.id];
    const isNewRouteForSocket = !previousBus || previousBus.routeId !== routeId;

    if (previousBus && previousBus.routeId !== routeId) {
      removeBus(socket);
    } else if (previousBus) {
      clearBusTimer(previousBus);
    }

    const wasRouteLive = isRouteLive(routeId);
    activeBuses[socket.id] = {
      routeId,
      label,
      driverId: driver.id,
      socketId: socket.id,
      lastLocation: previousBus?.lastLocation ?? null,
      expiresAt: getBusExpiry(data),
      timeoutId: null,
    };
    if (isNewRouteForSocket) {
      addRouteLive(routeId);
    }
    scheduleBusExpiry(socket, activeBuses[socket.id]);
    socket.join(routeId);

    console.log(
      `Bus Registered: Route ${routeId} (${label}) until ${new Date(
        activeBuses[socket.id].expiresAt,
      ).toISOString()}`,
    );
    socket.emit("bus_registered", {
      routeId,
      label,
      expiresAt: activeBuses[socket.id].expiresAt,
    });

    if (!wasRouteLive) {
      emitBusStatus("bus_online", activeBuses[socket.id], true);
    }
  });

  socket.on("join_route", (routeId) => {
    if (typeof routeId !== "string" || !routeId.trim()) {
      return;
    }

    const normalizedRouteId = routeId.trim();

    Array.from(socket.rooms).forEach((room) => {
      if (room !== socket.id) socket.leave(room);
    });

    socket.join(normalizedRouteId);
    console.log(`User tracking Route: ${normalizedRouteId}`);

    const bus = Object.values(activeBuses).find(
      (b) => b.routeId === normalizedRouteId,
    );

    if (bus && bus.lastLocation) {
      socket.emit("bus_moved", {
        ...bus.lastLocation,
        routeId: bus.routeId,
        label: bus.label,
      });
      return;
    }

    redisClient
      .get(latestLocationKey(normalizedRouteId))
      .then((latestLocation) => {
        if (latestLocation) {
          socket.emit("bus_moved", JSON.parse(latestLocation));
        } else {
          socket.emit("route_not_active", normalizedRouteId);
        }
      })
      .catch((err) => {
        console.error("Redis latest location lookup failed:", err);
        socket.emit("route_not_active", normalizedRouteId);
      });
  });

  socket.on("update_location", async (locationData) => {
    const busInfo = activeBuses[socket.id];

    if (!busInfo) {
      return;
    }

    const driver = await validateDriver(socket, locationData, busInfo.routeId);

    if (!driver || driver.id !== busInfo.driverId) {
      socket.emit("location_error", "Driver validation failed");
      return;
    }

    const lastUpdateAt = lastLocationUpdateBySocket.get(socket.id) ?? 0;
    const now = Date.now();

    if (now - lastUpdateAt < MIN_LOCATION_UPDATE_INTERVAL_MS) {
      return;
    }

    lastLocationUpdateBySocket.set(socket.id, now);

    const lat = Number(locationData?.lat);
    const lng = Number(locationData?.lng);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      return;
    }

    const payload = {
      routeId: busInfo.routeId,
      label: busInfo.label,
      lat,
      lng,
      heading: Number.isFinite(Number(locationData?.heading))
        ? Number(locationData.heading)
        : 0,
      timestamp: Number.isFinite(Number(locationData?.timestamp))
        ? Number(locationData.timestamp)
        : Date.now(),
    };

    busInfo.lastLocation = payload;
    await redisClient.set(
      latestLocationKey(busInfo.routeId),
      JSON.stringify(payload),
      { EX: STALE_BUS_TTL_SECONDS },
    );
    io.to(busInfo.routeId).emit("bus_moved", payload);
  });

  socket.on("stop_bus", () => {
    removeBus(socket);
  });

  socket.on("disconnect", () => {
    removeBus(socket);
  });
});

async function startServer() {
  await Promise.all([redisClient.connect(), redisSubscriber.connect()]);
  io.adapter(createAdapter(redisClient, redisSubscriber));

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`GovBus Server LIVE on Port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Server startup failed:", err);
  process.exit(1);
});
