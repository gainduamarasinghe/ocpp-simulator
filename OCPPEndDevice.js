/**
 * OCPP 1.6J Charge Point Simulator - Interactive Version
 * 
 * Setup:
 * 1. npm install ws uuid dayjs readline
 * 2. Configure settings below
 * 3. node OCPPEndDevice.js
 * 
 * Features:
 * - Interactive menu for testing
 * - Manual status changes (Available -> Preparing -> Charging)
 * - Simulate user RFID card swipe
 * - Remote start/stop support
 */

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');
const readline = require('readline');

// ======== CONFIGURATION - UPDATE THESE ========
const CP_ID = 'TG001';                    // Charger ID
const SERVER_HOST = 'localhost';          // Testing server IP 
const SERVER_PORT = 8090;                 // WebSocket port
const USE_SSL = false;                    // true for wss://, false for ws://

// Authentication (REQUIRED for your server)
const USERNAME = 'TG001';                 // username for this charger
const PASSWORD = 'ChargerAuthKeyTG001';  // password for this charger (from your ChargerRepository)

// Charger details
const VENDOR = 'MEV';
const MODEL = 'MEV-AC7kW';
const FIRMWARE = '1.0.0';
const SERIAL = 'SN-0001';

// Timing
const CONNECTOR_ID = 1;                   // Single-connector demo
const DEFAULT_HB_SEC = 60;                // Fallback heartbeat interval
const METER_PERIOD_SEC = 10;              // MeterValues interval during charging (10s for faster testing)

// ======== BUILD CONNECTION URL ========
const SERVER_URL = `${USE_SSL ? 'wss' : 'ws'}://${SERVER_HOST}:${SERVER_PORT}/${CP_ID}`;
const SUBPROTOCOL = 'ocpp1.6';
const BASIC_AUTH = 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');

// ======== STATE ========
let ws;
let connected = false;
let bootAccepted = false;
let hbTimer = null;
let meterTimer = null;

let currentStatus = 'Available';          // Track current status
let transactionActive = false;
let transactionId = null;
let currentMeterWh = 10_000;              // Demo counter in Wh
let meterStartWh = 0;
let lastIdTag = null;
let isRemoteStart = false;                // Track if started via remote

const pending = new Map();                // uid -> {resolve, reject, action}

// ======== READLINE FOR INTERACTIVE MENU ========
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

// ======== UTILITY FUNCTIONS ========
const nowRFC3339 = () => dayjs().toISOString();

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

function clearTimer(t) {
  if (t) clearInterval(t);
  return null;
}

function sendCALL(action, payload = {}) {
  const uid = uuidv4();
  const frame = [2, uid, action, payload];
  ws.send(JSON.stringify(frame));
  log(`=> ${action}`, payload);
  
  return new Promise((resolve, reject) => {
    pending.set(uid, { resolve, reject, action });
    setTimeout(() => {
      if (pending.has(uid)) {
        pending.delete(uid);
        reject(new Error(`Timeout waiting for ${action} (${uid})`));
      }
    }, 20_000);
  });
}

function sendCALLRESULT(uid, payload = {}) {
  ws.send(JSON.stringify([3, uid, payload]));
  log(`=> CALLRESULT (${uid})`, payload);
}

function sendCALLERROR(uid, code, description = '', details = {}) {
  ws.send(JSON.stringify([4, uid, code, description, details]));
  log(`=> CALLERROR (${uid})`, code, description);
}

// ======== CHARGE POINT BEHAVIORS ========
async function bootSequence() {
  log('Starting boot sequence...');
  
  const res = await sendCALL('BootNotification', {
    chargePointVendor: VENDOR,
    chargePointModel: MODEL,
    chargePointSerialNumber: SERIAL,
    firmwareVersion: FIRMWARE,
  });
  
  log('BootNotification response:', res);

  if (res.status !== 'Accepted') {
    throw new Error(`Boot not accepted: ${res.status}`);
  }

  bootAccepted = true;
  log('✅ Boot accepted!');

  // Start heartbeat
  const hbSec = res.interval || DEFAULT_HB_SEC;
  hbTimer = clearTimer(hbTimer);
  hbTimer = setInterval(() => {
    if (connected && bootAccepted) {
      sendCALL('Heartbeat').catch((err) => {
        log('Heartbeat error:', err.message);
      });
    }
  }, hbSec * 1000);
  log(`💓 Heartbeat scheduled every ${hbSec}s`);

  // Send initial connector status
  await sendStatus('Available');
  
  // Show interactive menu
  setTimeout(() => {
    showMenu();
  }, 1000);
}

async function sendStatus(status, errorCode = 'NoError') {
  currentStatus = status;
  await sendCALL('StatusNotification', {
    connectorId: CONNECTOR_ID,
    status,
    errorCode,
    timestamp: nowRFC3339(),
  });
  log(`📊 Status changed to: ${status}`);
}

async function authorize(idTag) {
  log(`🔐 Authorizing idTag: ${idTag}`);
  const res = await sendCALL('Authorize', { idTag });
  log('Authorization response:', res);
  return res;
}

async function startTransaction(idTag) {
  log(`🔌 Starting transaction for idTag: ${idTag}`);
  
  // Record meter start value
  meterStartWh = currentMeterWh;

  const res = await sendCALL('StartTransaction', {
    connectorId: CONNECTOR_ID,
    idTag,
    meterStart: meterStartWh,
    timestamp: nowRFC3339(),
  });

  transactionId = res.transactionId ?? 1;
  transactionActive = true;
  lastIdTag = idTag;

  log(`✅ Transaction started: id=${transactionId}, meterStart=${meterStartWh} Wh`);
  
  await sendStatus('Charging');
  startMeterLoop();
}

async function stopTransaction(reason = 'Remote') {
  if (!transactionActive) {
    log('❌ No active transaction to stop');
    return;
  }

  log(`🛑 Stopping transaction: id=${transactionId}, reason=${reason}`);
  stopMeterLoop();

  const res = await sendCALL('StopTransaction', {
    transactionId,
    meterStop: currentMeterWh,
    timestamp: nowRFC3339(),
    reason,
  });

  const energyKWh = (currentMeterWh - meterStartWh) / 1000;
  log(`✅ Transaction stopped: energy consumed = ${energyKWh.toFixed(3)} kWh`);

  transactionActive = false;
  transactionId = null;
  lastIdTag = null;
  isRemoteStart = false;
  
  await sendStatus('Available');
  
  // Show menu again
  setTimeout(() => {
    showMenu();
  }, 500);
  
  return res;
}

function startMeterLoop() {
  stopMeterLoop();
  log('📈 Starting meter value loop...');
  
  meterTimer = setInterval(() => {
    if (!transactionActive) return;
    
    // Simulate energy import: +120-200 Wh per tick (simulates ~4-7 kW charging)
    const increment = Math.floor(120 + Math.random() * 80);
    currentMeterWh += increment;

    const meterValue = [{
      timestamp: nowRFC3339(),
      sampledValue: [{
        value: String(currentMeterWh),
        measurand: 'Energy.Active.Import.Register',
        unit: 'Wh',
      }],
    }];

    const energyKWh = (currentMeterWh - meterStartWh) / 1000;
    log(`⚡ MeterValues: ${currentMeterWh} Wh (session: ${energyKWh.toFixed(3)} kWh)`);

    sendCALL('MeterValues', {
      connectorId: CONNECTOR_ID,
      transactionId,
      meterValue,
    }).catch((err) => {
      log('MeterValues error:', err.message);
    });
  }, METER_PERIOD_SEC * 1000);
}

function stopMeterLoop() {
  if (meterTimer) {
    log('⏹️  Stopping meter value loop');
    meterTimer = clearTimer(meterTimer);
  }
}

// ======== INTERACTIVE MENU ========
function showMenu() {
  if (!connected || !bootAccepted) return;
  
  console.log('\n' + '='.repeat(60));
  console.log('📱 INTERACTIVE MENU - Current Status: ' + currentStatus);
  console.log('='.repeat(60));
  console.log('Commands:');
  console.log('  1 - Simulate user plug-in (Available → Preparing)');
  console.log('  2 - Simulate RFID card swipe (start independent charging)');
  console.log('  3 - Stop current charging session');
  console.log('  4 - Change to Available status');
  console.log('  5 - Show current status');
  console.log('  6 - Show session info');
  console.log('  q - Quit simulator');
  console.log('='.repeat(60));
  console.log('💡 API Testing Flow:');
  console.log('   Step 1: Press 1 to plug in (status → Preparing)');
  console.log('   Step 2: Call your API: POST /api/start');
  console.log('   Step 3: Charging will start automatically');
  console.log('   Step 4: Call API: POST /api/stop (or press 3)');
  console.log('='.repeat(60));
  console.log('\nEnter command: ');
}

function handleMenuInput(input) {
  const cmd = input.trim();
  
  switch (cmd) {
    case '1':
      simulatePlugIn();
      break;
    case '2':
      simulateRFIDSwipe();
      break;
    case '3':
      handleManualStop();
      break;
    case '4':
      changeToAvailable();
      break;
    case '5':
      showCurrentStatus();
      break;
    case '6':
      showSessionInfo();
      break;
    case 'q':
    case 'Q':
      gracefulShutdown();
      break;
    default:
      console.log('❌ Invalid command. Try again.');
      showMenu();
  }
}

async function simulatePlugIn() {
  console.log('\n🔌 Simulating vehicle plug-in...');
  
  if (transactionActive) {
    console.log('❌ Cannot plug in - charging session is active');
    showMenu();
    return;
  }
  
  try {
    await sendStatus('Preparing');
    console.log('✅ Status changed to Preparing');
    console.log('💡 Now you can call your API: POST /api/start with stationId: PS001-1');
    showMenu();
  } catch (e) {
    console.log('❌ Error:', e.message);
    showMenu();
  }
}

async function simulateRFIDSwipe() {
  console.log('\n💳 Simulating RFID card swipe (independent charging)...');
  
  if (transactionActive) {
    console.log('❌ Charging session already active');
    showMenu();
    return;
  }
  
  if (currentStatus !== 'Preparing') {
    console.log('⚠️  Vehicle not plugged in. Changing to Preparing first...');
    await sendStatus('Preparing');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  const idTag = 'USER-RFID-' + Math.floor(Math.random() * 1000);
  
  try {
    // Authorize
    const auth = await authorize(idTag);
    const status = auth?.idTagInfo?.status || 'Accepted';
    
    if (status !== 'Accepted') {
      console.log(`❌ Authorization rejected: ${status}`);
      await sendStatus('Available');
      showMenu();
      return;
    }
    
    // Start transaction
    console.log('✅ Authorization accepted, starting charging...');
    await startTransaction(idTag);
    console.log('✅ Independent charging session started!');
    console.log('💡 This is a user-initiated session (not API-managed)');
    
  } catch (e) {
    console.log('❌ Error:', e.message);
    await sendStatus('Available');
    showMenu();
  }
}

async function handleManualStop() {
  console.log('\n🛑 Stopping charging session...');
  
  if (!transactionActive) {
    console.log('❌ No active charging session');
    showMenu();
    return;
  }
  
  try {
    await stopTransaction('Local');
    console.log('✅ Charging session stopped');
  } catch (e) {
    console.log('❌ Error:', e.message);
  }
}

async function changeToAvailable() {
  console.log('\n📊 Changing status to Available...');
  
  if (transactionActive) {
    console.log('❌ Cannot change status - charging session is active');
    console.log('💡 Stop the charging session first (press 3)');
    showMenu();
    return;
  }
  
  try {
    await sendStatus('Available');
    console.log('✅ Status changed to Available');
    showMenu();
  } catch (e) {
    console.log('❌ Error:', e.message);
    showMenu();
  }
}

function showCurrentStatus() {
  console.log('\n📊 Current Status:');
  console.log('  Status: ' + currentStatus);
  console.log('  Connected: ' + (connected ? 'Yes' : 'No'));
  console.log('  Boot Accepted: ' + (bootAccepted ? 'Yes' : 'No'));
  console.log('  Transaction Active: ' + (transactionActive ? 'Yes' : 'No'));
  if (transactionActive) {
    console.log('  Transaction ID: ' + transactionId);
    console.log('  Start Type: ' + (isRemoteStart ? 'Remote/API' : 'Independent/RFID'));
  }
  showMenu();
}

function showSessionInfo() {
  console.log('\n📈 Session Information:');
  
  if (!transactionActive) {
    console.log('  No active session');
  } else {
    const energyKWh = (currentMeterWh - meterStartWh) / 1000;
    console.log('  Transaction ID: ' + transactionId);
    console.log('  ID Tag: ' + lastIdTag);
    console.log('  Start Type: ' + (isRemoteStart ? 'Remote/API' : 'Independent/RFID'));
    console.log('  Start Meter: ' + meterStartWh + ' Wh');
    console.log('  Current Meter: ' + currentMeterWh + ' Wh');
    console.log('  Energy Consumed: ' + energyKWh.toFixed(3) + ' kWh');
  }
  
  showMenu();
}

// ======== HANDLE INCOMING CSMS CALLS ========
async function handleIncoming(uid, action, payload) {
  log(`<= ${action}`, payload);

  switch (action) {
    case 'RemoteStartTransaction': {
      const idTag = payload?.idTag || 'API-TAG';
      const connectorId = payload?.connectorId || CONNECTOR_ID;
      
      log(`🎯 RemoteStartTransaction requested: idTag=${idTag}, connector=${connectorId}`);
      console.log('\n🚨 REMOTE START REQUEST RECEIVED FROM SERVER!');
      
      try {
        // Check if already in Preparing status
        if (currentStatus !== 'Preparing') {
          console.log('⚠️  Status is not Preparing. Changing status...');
          await sendStatus('Preparing');
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        // Authorize the ID tag
        const auth = await authorize(idTag);
        const status = auth?.idTagInfo?.status || 'Accepted';

        if (status !== 'Accepted') {
          log(`❌ Authorization rejected: ${status}`);
          sendCALLRESULT(uid, { status: 'Rejected' });
          await sendStatus('Available');
          showMenu();
          return;
        }
        
        // Start the transaction
        console.log('✅ Authorization accepted, starting charging...');
        isRemoteStart = true;
        await startTransaction(idTag);
        sendCALLRESULT(uid, { status: 'Accepted' });
        console.log('✅ Remote charging session started!');
        console.log('💡 This is an API-managed session');
        
      } catch (e) {
        log('❌ RemoteStartTransaction error:', e.message);
        sendCALLERROR(uid, 'GenericError', e.message);
        await sendStatus('Available');
        showMenu();
      }
      return;
    }

    case 'RemoteStopTransaction': {
      log('🛑 RemoteStopTransaction requested');
      console.log('\n🚨 REMOTE STOP REQUEST RECEIVED FROM SERVER!');
      
      try {
        if (transactionActive) {
          await stopTransaction('Remote');
          sendCALLRESULT(uid, { status: 'Accepted' });
          console.log('✅ Remote stop completed');
        } else {
          log('❌ No active transaction to stop');
          sendCALLRESULT(uid, { status: 'Rejected' });
          showMenu();
        }
      } catch (e) {
        log('❌ RemoteStopTransaction error:', e.message);
        sendCALLERROR(uid, 'GenericError', e.message);
        showMenu();
      }
      return;
    }

    case 'Reset': {
      const resetType = payload?.type || 'Soft';
      log(`🔄 Reset requested: ${resetType}`);
      sendCALLRESULT(uid, { status: 'Accepted' });
      setTimeout(() => {
        log('Executing reset...');
        ws.close();
      }, 300);
      return;
    }

    case 'ChangeAvailability': {
      log('📊 ChangeAvailability received');
      sendCALLRESULT(uid, { status: 'Accepted' });
      return;
    }

    case 'UnlockConnector': {
      log('🔓 UnlockConnector received');
      sendCALLRESULT(uid, { status: 'Unlocked' });
      return;
    }

    default:
      log(`❌ Action not implemented: ${action}`);
      sendCALLERROR(uid, 'NotImplemented', `Action ${action} not implemented`, {});
      return;
  }
}

// ======== WEBSOCKET CONNECTION ========
function connect() {
  log('='.repeat(60));
  log(`🔌 Connecting to OCPP Server`);
  log(`  Charger ID: ${CP_ID}`);
  log(`  Server URL: ${SERVER_URL}`);
  log(`  Protocol: ${SUBPROTOCOL}`);
  log(`  Auth: ${USERNAME}`);
  log('='.repeat(60));
  
  ws = new WebSocket(SERVER_URL, [SUBPROTOCOL], {
    headers: {
      Authorization: BASIC_AUTH,
    },
  });

  ws.on('open', async () => {
    connected = true;
    log('✅ WebSocket CONNECTED!');
    
    try {
      await bootSequence();
    } catch (e) {
      log('❌ Boot sequence failed:', e.message);
      ws.close();
    }
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return log('❌ Invalid JSON from server:', data.toString());
    }
    
    if (!Array.isArray(msg) || msg.length < 3) {
      return log('❌ Invalid OCPP frame:', msg);
    }

    const [type, uid] = msg;
    
    if (type === 3) {
      // CALLRESULT from server
      const p = pending.get(uid);
      if (!p) return;
      pending.delete(uid);
      const [, , payload] = msg;
      log(`<= CALLRESULT for ${p.action}`, payload);
      p.resolve(payload);
      
    } else if (type === 4) {
      // CALLERROR from server
      const p = pending.get(uid);
      if (!p) return;
      pending.delete(uid);
      const [, , code, desc] = msg;
      log(`<= CALLERROR for ${p.action}: ${code} - ${desc}`);
      p.reject(new Error(`${p.action} failed: ${code} ${desc}`));
      
    } else if (type === 2) {
      // CALL from server (incoming request)
      const [, , action, payload] = msg;
      handleIncoming(uid, action, payload).catch(err => {
        log('❌ Handler error:', err.message);
        sendCALLERROR(uid, 'GenericError', err.message);
      });
      
    } else {
      log('❌ Unknown OCPP message type:', type);
    }
  });

  ws.on('close', (code, reason) => {
    connected = false;
    bootAccepted = false;
    hbTimer = clearTimer(hbTimer);
    stopMeterLoop();
    
    log('❌ WebSocket CLOSED');
    log(`  Code: ${code}`);
    log(`  Reason: ${reason || 'No reason provided'}`);
    log('🔄 Reconnecting in 5 seconds...');
    
    setTimeout(connect, 5000);
  });

  ws.on('error', (err) => {
    log('❌ WebSocket ERROR:', err.message);
  });
}

// ======== GRACEFUL SHUTDOWN ========
async function gracefulShutdown() {
  log('\n👋 Shutting down gracefully...');
  
  if (transactionActive) {
    try {
      await stopTransaction('Local');
    } catch (e) {
      log('❌ Error stopping transaction:', e.message);
    }
  }
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  
  rl.close();
  process.exit(0);
}

// ======== START ========
console.log('\n' + '='.repeat(60));
console.log('⚡ OCPP 1.6J Charge Point Simulator - Interactive Version');
console.log('='.repeat(60));
log('Vendor:', VENDOR);
log('Model:', MODEL);
log('Serial:', SERIAL);
console.log('='.repeat(60));
log('');
connect();

// Handle user input
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  handleMenuInput(data);
});

// Handle graceful shutdown
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);