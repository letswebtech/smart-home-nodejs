const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = createServer(app);

// FIXED: Added proper Socket.IO configuration
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,        // 60 seconds before considering connection dead
  pingInterval: 25000,       // Send ping every 25 seconds
  transports: ['websocket', 'polling'],
  allowEIO3: true            // Support older Engine.IO versions if needed
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const connectedDevices = new Map();
const connectedUsers = new Map();
const deviceUserMap = new Map();

// Connection monitoring constants
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_TIMEOUT = 5000;   // 5 seconds
const CONNECTION_STATES = {
  CONNECTED: 'connected',
  UNSTABLE: 'unstable',
  DISCONNECTED: 'disconnected'
};

// Connection monitoring function
const monitorConnection = (socket) => {
  let missedHeartbeats = 0;
  let connectionState = CONNECTION_STATES.CONNECTED;
  let lastHeartbeatTime = Date.now();

  const heartbeatInterval = setInterval(() => {
    const start = Date.now();
    socket.emit('heartbeat');

    missedHeartbeats++;
    if (missedHeartbeats >= 2) {
      connectionState = CONNECTION_STATES.UNSTABLE;
      socket.emit('connection_status', { state: connectionState });
    }

    if (missedHeartbeats >= 3) {
      connectionState = CONNECTION_STATES.DISCONNECTED;
      socket.emit('connection_status', { state: connectionState });
      socket.disconnect(true);
    }
  }, HEARTBEAT_INTERVAL);

  socket.on('heartbeat_ack', () => {
    missedHeartbeats = 0;
    const latency = Date.now() - lastHeartbeatTime;
    lastHeartbeatTime = Date.now();

    const newState = latency > 1000 ? CONNECTION_STATES.UNSTABLE : CONNECTION_STATES.CONNECTED;
    if (newState !== connectionState) {
      connectionState = newState;
      socket.emit('connection_status', {
        state: connectionState,
        latency: latency
      });
    }
  });

  socket.on('disconnect', () => {
    clearInterval(heartbeatInterval);
  });

  return heartbeatInterval;
};

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // FIXED: Added support for both 'device_register' AND 'device_online'
  const handleDeviceRegistration = (data) => {
    const { macAddress, userId, gpioStatus } = data;

    // FIXED: Make userId optional for initial connection
    if (!macAddress) {
      socket.emit('error', { message: 'MAC address is required' });
      return;
    }

    // Use default userId if not provided (for backward compatibility)
    const deviceUserId = userId || 'default_user';

    const deviceInfo = {
      socketId: socket.id,
      macAddress,
      userId: deviceUserId,
      gpioStatus: gpioStatus || {},
      lastSeen: new Date(),
      type: 'device',
      connectionState: CONNECTION_STATES.CONNECTED,
      heartbeatInterval: monitorConnection(socket)
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

    console.log(`IoT Device registered: ${macAddress} for user ${deviceUserId}`);
  };

  // Support both event names
  socket.on('device_register', handleDeviceRegistration);
  socket.on('device_online', handleDeviceRegistration);  // FIXED: Added this

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

    console.log(`GPIO status updated for device ${macAddress}:`, gpioStatus);
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
      connectionState: CONNECTION_STATES.CONNECTED,
      heartbeatInterval: monitorConnection(socket)
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
      macAddress,  // FIXED: Added macAddress to command
      timestamp: new Date()
    };

    // FIXED: Send both event names for compatibility
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

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);

    for (const [macAddress, device] of connectedDevices.entries()) {
      if (device.socketId === socket.id) {
        // FIXED: Clear heartbeat interval
        if (device.heartbeatInterval) {
          clearInterval(device.heartbeatInterval);
        }

        connectedDevices.delete(macAddress);

        socket.to(`user_${device.userId}`).emit('device_offline', {
          macAddress,
          timestamp: new Date()
        });

        console.log(`IoT Device disconnected: ${macAddress}`);
        break;
      }
    }

    for (const [userId, user] of connectedUsers.entries()) {
      if (user.socketId === socket.id) {
        // FIXED: Clear heartbeat interval
        if (user.heartbeatInterval) {
          clearInterval(user.heartbeatInterval);
        }

        connectedUsers.delete(userId);
        console.log(`User disconnected: ${userId}`);
        break;
      }
    }
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
