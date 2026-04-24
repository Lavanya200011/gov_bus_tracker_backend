const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);

// 1. --- MONGODB CONFIGURATION ---
// Replace 'YOUR_MONGODB_CONNECTION_STRING' with your actual Atlas string
const mongoURI = 'mongodb+srv://lavanyathawkar11_db:Lavanyath@cluster0.nol8utr.mongodb.net/?appName=Cluster0';

mongoose.connect(mongoURI)
  .then(() => {
    console.log("📦 Connected to MongoDB Atlas");
    seedRoutes(); // Initialize database with some routes if empty
  })
  .catch(err => console.error("❌ MongoDB Error:", err));

// 2. --- ROUTE SCHEMA & MODEL ---
const RouteSchema = new mongoose.Schema({
  routeId: { type: String, required: true, unique: true },
  label: { type: String, required: true },
  startPoint: String,
  destination: String
});

const Route = mongoose.model('Route', RouteSchema);

// Helper function to add initial data to your database
async function seedRoutes() {
  const count = await Route.countDocuments();
  if (count === 0) {
    await Route.create([
      { routeId: "101", label: "Sakoli ➔ Bhandara", startPoint: "Sakoli", destination: "Bhandara" },
      { routeId: "102", label: "Nagpur ➔ Wardha", startPoint: "Nagpur", destination: "Wardha" },
      { routeId: "123", label: "Pune ➔ Mumbai", startPoint: "Pune", destination: "Mumbai" }
    ]);
    console.log("🌱 Database Seeded: Initial routes added!");
  }
}

// 3. --- SOCKET.IO SETUP ---
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['websocket'] 
});

let activeBuses = {}; // Live tracking memory: { socketId: { routeId, label, lastLocation } }

io.on('connection', (socket) => {
  console.log('✅ Connected:', socket.id);

  // 4. --- UPDATED: FETCH BUS LIST FROM DB + LIVE STATUS ---
  socket.on('request_bus_list', async () => {
    try {
      const officialRoutes = await Route.find(); // Get all routes from MongoDB
      
      // Merge DB data with live tracking status
      const list = officialRoutes.map(route => {
        // Check if anyone is currently broadcasting this routeId
        const isLive = Object.values(activeBuses).some(b => b.routeId === route.routeId);
        return {
          routeId: route.routeId,
          label: route.label,
          isLive: isLive
        };
      });

      socket.emit('active_buses_list', list);
    } catch (err) {
      console.error("Error fetching bus list:", err);
    }
  });

  socket.on('register_bus', (data) => {
    const { routeId, label } = data;
    activeBuses[socket.id] = { routeId, label, socketId: socket.id, lastLocation: null };
    socket.join(routeId);
    console.log(`\x1b[32m🚌 Bus Registered: Route ${routeId} (${label})\x1b[0m`);
    
    // Broadcast update to refresh everyone's "Active Buses" tab
    io.emit('active_buses_list_trigger'); 
  });

  socket.on('join_route', (routeId) => {
    Array.from(socket.rooms).forEach(room => {
      if (room !== socket.id) socket.leave(room);
    });
    socket.join(routeId);
    console.log(`👤 User tracking Route: ${routeId}`);

    // Instant Speed Fix: Send cached location immediately if available
    const bus = Object.values(activeBuses).find(b => b.routeId === routeId);
    if (bus && bus.lastLocation) {
      socket.emit('bus_moved', { 
        ...bus.lastLocation, 
        routeId: bus.routeId, 
        label: bus.label 
      });
    } else if (!bus) {
      socket.emit('route_not_active', routeId);
    }
  });

  socket.on('update_location', (locationData) => {
    const busInfo = activeBuses[socket.id];
    if (busInfo) {
      busInfo.lastLocation = locationData;
      const payload = { ...locationData, routeId: busInfo.routeId, label: busInfo.label };
      io.to(busInfo.routeId).emit('bus_moved', payload);
    }
  });

  socket.on('disconnect', () => {
    if (activeBuses[socket.id]) {
      console.log(`❌ Bus ${activeBuses[socket.id].routeId} offline`);
      delete activeBuses[socket.id];
      io.emit('active_buses_list_trigger'); 
    }
  });
});

const PORT = 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 GovBus Server LIVE on Port ${PORT}`);
});