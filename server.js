const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = createServer(app);

// Socket.IO configuration optimized for ESP32 devices
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: false
  },
  pingTimeout: 120000,       // 120 seconds - ESP32 devices may be slow to respond
  pingInterval: 45000,       // Send ping every 45 seconds (less frequent)
  transports: ['polling', 'websocket'], // Try polling first for ESP32 compatibility
  allowEIO3: true,           // CRITICAL: Support Engine.IO v3 for ESP32
  upgradeTimeout: 30000,     // Allow more time for transport upgrade
  maxHttpBufferSize: 1e6,    // 1MB buffer
  perMessageDeflate: false,  // Disable compression for IoT devices
  connectTimeout: 45000,     // Allow more time for initial connection
  allowUpgrades: true,       // Allow transport upgrades
  cookie: false              // Disable cookies for IoT devices
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date(),
    connectedDevices: connectedDevices.size,
    connectedUsers: connectedUsers.size
  });
});

// Debug endpoint to see connected devices
app.get('/api/devices', (req, res) => {
  const devices = [];
  for (const [macAddress, device] of connectedDevices.entries()) {
    devices.push({
      macAddress,
      userId: device.userId,
      socketId: device.socketId,
      lastSeen: device.lastSeen,
      gpioStatus: device.gpioStatus
    });
  }
  res.json({ devices });
});

const connectedDevices = new Map();
const connectedUsers = new Map();
const deviceUserMap = new Map();

const CONNECTION_STATES = {
  CONNECTED: 'connected',
  UNSTABLE: 'unstable',
  DISCONNECTED: 'disconnected'
};

io.on('connection', (socket) => {
  const userAgent = socket.handshake.headers['user-agent'] || 'Unknown';
  const isESP32 = userAgent.includes('ESP32') || userAgent.includes('arduino-WebSocket') || !userAgent.includes('Mozilla');
  const clientType = isESP32 ? '🔌 ESP32 Device' : '🌐 Browser';

  console.log(`✓ ${clientType} connected: ${socket.id}`);
  console.log(`  - Transport: ${socket.conn.transport.name}`);
  console.log(`  - Protocol: EIO v${socket.conn.protocol}`);
  console.log(`  - User-Agent: ${userAgent}`);
  console.log(`  - Remote IP: ${socket.handshake.address}`);

  // Log transport upgrade events
  socket.conn.on('upgrade', (transport) => {
    console.log(`📡 Transport upgraded to: ${transport.name} for ${clientType} ${socket.id}`);
  });

  // Track if device registers within reasonable time
  const registrationTimeout = setTimeout(() => {
    let isRegistered = false;
    for (const [mac, device] of connectedDevices.entries()) {
      if (device.socketId === socket.id) {
        isRegistered = true;
        break;
      }
    }
    if (!isRegistered) {
      console.log(`⚠️ Client ${socket.id} connected but never registered as device or user`);
    }
  }, 15000); // 15 second timeout - increased for ESP32

  socket.on('disconnect', () => {
    clearTimeout(registrationTimeout);
  });

  // Device registration handler
  const handleDeviceRegistration = (data) => {
    console.log('Device registration attempt:', JSON.stringify(data));

    const { macAddress, userId, gpioStatus } = data;

    if (!macAddress) {
      console.error('Registration failed: No MAC address provided');
      socket.emit('error', { message: 'MAC address is required' });
      return;
    }

    const deviceUserId = userId || 'default_user';

    const deviceInfo = {
      socketId: socket.id,
      macAddress,
      userId: deviceUserId,
      gpioStatus: gpioStatus || {},
      lastSeen: new Date(),
      type: 'device',
      connectionState: CONNECTION_STATES.CONNECTED
    };

    connectedDevices.set(macAddress, deviceInfo);

    if (!deviceUserMap.has(deviceUserId)) {
      deviceUserMap.set(deviceUserId, new Set());
    }
    deviceUserMap.get(deviceUserId).add(macAddress);

    socket.join(`user_${deviceUserId}`);

    socket.emit('device_registered', {
      message: 'Device registered successfully',
      macAddress
    });

    socket.to(`user_${deviceUserId}`).emit('device_online', {
      macAddress,
      gpioStatus: gpioStatus || {},
      timestamp: new Date()
    });

    console.log(`✓ IoT Device registered: ${macAddress} for user ${deviceUserId} (Socket: ${socket.id})`);
  };

  // Support both event names
  socket.on('device_register', handleDeviceRegistration);
  socket.on('device_online', handleDeviceRegistration);

  socket.on('gpio_status_update', (data) => {
    const { macAddress, gpioStatus } = data;

    const device = connectedDevices.get(macAddress);
    if (!device || device.socketId !== socket.id) {
      socket.emit('error', { message: 'Device not found or unauthorized' });
      return;
    }

    device.gpioStatus = { ...device.gpioStatus, ...gpioStatus };
    device.lastSeen = new Date();

    io.to(`user_${device.userId}`).emit('gpio_status_changed', {
      macAddress,
      gpioStatus: device.gpioStatus,
      timestamp: new Date()
    });

    console.log(`GPIO status updated for device ${macAddress}`);
  });

  // Update lastSeen when device sends heartbeat
  socket.on('heartbeat_ack', () => {
    // Find device by socket ID
    for (const [macAddress, device] of connectedDevices.entries()) {
      if (device.socketId === socket.id) {
        device.lastSeen = new Date();
        device.connectionState = CONNECTION_STATES.CONNECTED;
        break;
      }
    }
  });

  socket.on('user_connect', (data) => {
    const { userId } = data;

    if (!userId) {
      socket.emit('error', { message: 'userId is required' });
      return;
    }

    const userInfo = {
      socketId: socket.id,
      userId,
      lastSeen: new Date(),
      type: 'user',
      connectionState: CONNECTION_STATES.CONNECTED
    };

    connectedUsers.set(userId, userInfo);
    socket.join(`user_${userId}`);

    const userDevices = [];
    if (deviceUserMap.has(userId)) {
      deviceUserMap.get(userId).forEach(macAddress => {
        const device = connectedDevices.get(macAddress);
        if (device) {
          userDevices.push({
            macAddress,
            gpioStatus: device.gpioStatus,
            lastSeen: device.lastSeen
          });
        }
      });
    }

    socket.emit('user_connected', {
      message: 'User connected successfully',
      devices: userDevices
    });

    console.log(`User connected: ${userId}`);
  });

  socket.on('gpio_control', (data) => {
    const { macAddress, pinNumber, state, userId } = data;

    if (!macAddress || pinNumber === undefined || state === undefined || !userId) {
      socket.emit('error', { message: 'macAddress, pinNumber, state, and userId are required' });
      return;
    }

    const device = connectedDevices.get(macAddress);
    if (!device) {
      socket.emit('error', { message: 'Device not found' });
      return;
    }

    if (device.userId !== userId) {
      socket.emit('error', { message: 'Unauthorized: Device belongs to different user' });
      return;
    }

    const controlCommand = {
      pinNumber,
      state,
      macAddress,
      timestamp: new Date()
    };

    // Send both event names for compatibility
    io.to(device.socketId).emit('gpio_control_command', controlCommand);
    io.to(device.socketId).emit('gpio_control', controlCommand);

    const pinKey = `pin${pinNumber}`;
    device.gpioStatus[pinKey] = state;
    device.lastSeen = new Date();

    io.to(`user_${device.userId}`).emit('gpio_status_changed', {
      macAddress,
      gpioStatus: device.gpioStatus,
      timestamp: new Date()
    });

    socket.emit('gpio_control_sent', {
      message: 'GPIO control command sent',
      macAddress,
      pinNumber,
      state
    });

    console.log(`GPIO control sent to device ${macAddress}: Pin ${pinNumber} -> ${state}`);
  });

  socket.on('get_device_status', (data) => {
    const { macAddress, userId } = data;

    const device = connectedDevices.get(macAddress);
    if (!device) {
      socket.emit('error', { message: 'Device not found' });
      return;
    }

    if (device.userId !== userId) {
      socket.emit('error', { message: 'Unauthorized: Device belongs to different user' });
      return;
    }

    socket.emit('device_status', {
      macAddress,
      gpioStatus: device.gpioStatus,
      lastSeen: device.lastSeen,
      isOnline: true
    });
  });

  socket.on('get_user_devices', (data) => {
    const { userId } = data;

    const userDevices = [];
    if (deviceUserMap.has(userId)) {
      deviceUserMap.get(userId).forEach(macAddress => {
        const device = connectedDevices.get(macAddress);
        if (device) {
          userDevices.push({
            macAddress,
            gpioStatus: device.gpioStatus,
            lastSeen: device.lastSeen,
            isOnline: true
          });
        }
      });
    }

    socket.emit('user_devices', {
      userId,
      devices: userDevices
    });
  });

  socket.on('disconnect', (reason) => {
    console.log(`Client disconnected: ${socket.id} - Reason: ${reason}`);

    for (const [macAddress, device] of connectedDevices.entries()) {
      if (device.socketId === socket.id) {
        connectedDevices.delete(macAddress);

        socket.to(`user_${device.userId}`).emit('device_offline', {
          macAddress,
          timestamp: new Date()
        });

        console.log(`IoT Device disconnected: ${macAddress} - Reason: ${reason}`);
        break;
      }
    }

    for (const [userId, user] of connectedUsers.entries()) {
      if (user.socketId === socket.id) {
        connectedUsers.delete(userId);
        console.log(`User disconnected: ${userId} - Reason: ${reason}`);
        break;
      }
    }
  });

  // Add error handler
  socket.on('error', (error) => {
    console.error(`Socket error for ${socket.id}:`, error);
  });

});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Socket server running on port ${PORT}`);
});

process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
