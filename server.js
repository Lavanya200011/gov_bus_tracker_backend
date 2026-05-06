require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;
const SOCKET_CORS_ORIGIN = process.env.SOCKET_CORS_ORIGIN || "*";

// 1. --- MONGODB CONFIGURATION ---
const mongoURI = process.env.MONGO_URI;

if (!mongoURI) {
  console.error("MONGO_URI is required. Add it to your environment variables.");
  process.exit(1);
}

mongoose
  .connect(mongoURI)
  .then(() => {
    console.log("Connected to MongoDB Atlas");
    // seedRoutes(); // Initialize database with some routes if empty
  })
  .catch((err) => {
    console.error("MongoDB Error:", err);
    process.exit(1);
  });

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// 2. --- ROUTE SCHEMA & MODEL ---
const RouteSchema = new mongoose.Schema({
  routeId: { type: String, required: true, unique: true },
  label: { type: String, required: true },
  startPoint: String,
  destination: String,
});

const Route = mongoose.model("Route", RouteSchema);

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

// 3. --- SOCKET.IO SETUP ---
const io = new Server(server, {
  cors: { origin: SOCKET_CORS_ORIGIN, methods: ["GET", "POST"] },
  transports: ["websocket"],
});

const DEFAULT_BROADCAST_DURATION_MS = 60 * 60 * 1000;
const MIN_BROADCAST_DURATION_MS = 60 * 1000;
const MAX_BROADCAST_DURATION_MS = 12 * 60 * 60 * 1000;

// Live tracking memory: { socketId: { routeId, label, socketId, lastLocation, expiresAt, timeoutId } }
const activeBuses = {};

function isRouteLive(routeId) {
  return Object.values(activeBuses).some((bus) => bus.routeId === routeId);
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
  socket.leave(bus.routeId);

  console.log(`Bus ${bus.routeId} offline (${reason})`);

  if (!isRouteLive(bus.routeId)) {
    emitBusStatus("bus_offline", bus, false);
  }
}

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // 4. --- FETCH BUS LIST FROM DB + LIVE STATUS ---
  socket.on("request_bus_list", async () => {
    try {
      const officialRoutes = await Route.find().lean();

      const list = officialRoutes.map((route) => ({
        routeId: route.routeId,
        label: route.label,
        isLive: isRouteLive(route.routeId),
      }));

      socket.emit("active_buses_list", list);
    } catch (err) {
      console.error("Error fetching bus list:", err);
    }
  });

  socket.on("register_bus", (data) => {
    const routeId =
      typeof data?.routeId === "string" ? data.routeId.trim() : "";
    const label = typeof data?.label === "string" ? data.label.trim() : "";

    if (!routeId || !label) {
      socket.emit("registration_error", "routeId and label are required");
      return;
    }

    const previousBus = activeBuses[socket.id];

    if (previousBus && previousBus.routeId !== routeId) {
      removeBus(socket);
    } else if (previousBus) {
      clearBusTimer(previousBus);
    }

    const wasRouteLive = isRouteLive(routeId);
    activeBuses[socket.id] = {
      routeId,
      label,
      socketId: socket.id,
      lastLocation: previousBus?.lastLocation ?? null,
      expiresAt: getBusExpiry(data),
      timeoutId: null,
    };
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
    } else if (!bus) {
      socket.emit("route_not_active", normalizedRouteId);
    }
  });

  socket.on("update_location", (locationData) => {
    const busInfo = activeBuses[socket.id];

    if (!busInfo) {
      return;
    }

    const lat = Number(locationData?.lat);
    const lng = Number(locationData?.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
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
    io.to(busInfo.routeId).emit("bus_moved", payload);
  });

  socket.on("stop_bus", () => {
    removeBus(socket);
  });

  socket.on("disconnect", () => {
    removeBus(socket);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`GovBus Server LIVE on Port ${PORT}`);
});
