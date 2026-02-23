import aedes from 'aedes';
import type { AedesPublishPacket, Client } from 'aedes';
const { createBroker } = aedes;
import fs from 'fs';
import { createServer as createHttpsServer } from 'https';
import { createServer, Server } from 'net';
import path from 'path';
import { WebSocketServer, createWebSocketStream, type WebSocket } from 'ws';

import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface MqttChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

const TOPIC_IN = 'nanoclaw/in';
const TOPIC_OUT = 'nanoclaw/out';
const TOPIC_STATUS = 'nanoclaw/status';
const JID = 'mqtt:local';

export class MqttChannel implements Channel {
  name = 'mqtt';

  private aedes: ReturnType<typeof createBroker> | null = null;
  private server: Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private port: number;
  private opts: MqttChannelOpts;

  constructor(port: number, opts: MqttChannelOpts) {
    this.port = port;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.aedes = createBroker();
    this.server = createServer(this.aedes.handle);

    this.aedes.on('publish', (packet: AedesPublishPacket, client: Client | null) => {
      // Ignore internal broker messages (no client) and non-inbound topics
      if (!client || packet.topic !== TOPIC_IN) return;

      const content = packet.payload.toString('utf-8').trim();
      if (!content) return;

      const timestamp = new Date().toISOString();
      const msgId = `mqtt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Emit metadata so the chat appears in discovery
      this.opts.onChatMetadata(JID, timestamp, 'MQTT Local', 'mqtt', false);

      // Only deliver if registered
      const group = this.opts.registeredGroups()[JID];
      if (!group) {
        logger.debug('MQTT message from unregistered chat');
        return;
      }

      this.opts.onMessage(JID, {
        id: msgId,
        chat_jid: JID,
        sender: client.id || 'mqtt-client',
        sender_name: client.id || 'MQTT',
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info({ clientId: client.id }, 'MQTT message received');
    });

    // Emit metadata on connect so mqtt:local is discoverable immediately
    this.opts.onChatMetadata(JID, new Date().toISOString(), 'MQTT Local', 'mqtt', false);

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, () => {
        // WebSocket transport on port+1 (same Aedes broker, for browser clients)
        // Uses WSS if TLS certs are found, plain WS otherwise.
        const wsPort = this.port + 1;
        const tls = loadTlsCerts();
        let wsProto: string;

        if (tls) {
          const httpsServer = createHttpsServer(tls);
          this.wsServer = new WebSocketServer({ server: httpsServer });
          httpsServer.listen(wsPort);
          wsProto = 'wss';
        } else {
          this.wsServer = new WebSocketServer({ port: wsPort });
          wsProto = 'ws';
        }

        this.wsServer.on('connection', (ws: WebSocket) => {
          const stream = createWebSocketStream(ws);
          this.aedes!.handle(stream);
        });

        // Publish retained online status
        this.publishRetained(TOPIC_STATUS, JSON.stringify({ status: 'online' }));
        logger.info({ port: this.port, wsPort, wsProto }, 'MQTT broker listening');
        console.log(`\n  MQTT broker: port ${this.port} (tcp), ${wsPort} (${wsProto})`);
        console.log(`  Send:    mosquitto_pub -t ${TOPIC_IN} -m "hello"`);
        console.log(`  Listen:  mosquitto_sub -t ${TOPIC_OUT}\n`);
        resolve();
      });

      this.server!.on('error', (err) => {
        logger.error({ err }, 'MQTT server error');
        reject(err);
      });
    });
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    if (!this.aedes) {
      logger.warn('MQTT broker not initialized');
      return;
    }

    this.aedes.publish(
      {
        topic: TOPIC_OUT,
        payload: Buffer.from(text),
        qos: 0,
        retain: false,
        cmd: 'publish',
        dup: false,
      },
      (err?: Error) => {
        if (err) logger.error({ err }, 'Failed to publish MQTT message');
      },
    );
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('mqtt:');
  }

  isConnected(): boolean {
    return this.server !== null && this.server.listening;
  }

  async disconnect(): Promise<void> {
    if (this.aedes) {
      // Publish offline status before shutting down
      this.publishRetained(TOPIC_STATUS, JSON.stringify({ status: 'offline' }));

      await new Promise<void>((resolve) => {
        this.aedes!.close(() => {
          this.aedes = null;
          resolve();
        });
      });
    }

    if (this.wsServer) {
      await new Promise<void>((resolve) => {
        this.wsServer!.close(() => {
          this.wsServer = null;
          resolve();
        });
      });
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => {
          this.server = null;
          resolve();
        });
      });
    }

    logger.info('MQTT broker stopped');
  }

  private publishRetained(topic: string, payload: string): void {
    if (!this.aedes) return;
    this.aedes.publish(
      {
        topic,
        payload: Buffer.from(payload),
        qos: 0,
        retain: true,
        cmd: 'publish',
        dup: false,
      },
      () => {},
    );
  }
}

/**
 * Look for TLS certs for the WSS listener.
 * Checks env vars first, then a conventional path in the data dir.
 * Returns null if no certs found (falls back to plain WS).
 */
function loadTlsCerts(): { key: Buffer; cert: Buffer } | null {
  // Env var paths take priority
  const keyPath = process.env.MQTT_TLS_KEY;
  const certPath = process.env.MQTT_TLS_CERT;
  if (keyPath && certPath) {
    try {
      return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    } catch (err) {
      logger.warn({ err, keyPath, certPath }, 'TLS certs specified but unreadable, falling back to ws://');
      return null;
    }
  }

  // Convention: data/tls/mqtt.key + data/tls/mqtt.crt
  const dataDir = path.resolve(process.cwd(), 'data', 'tls');
  const defaultKey = path.join(dataDir, 'mqtt.key');
  const defaultCert = path.join(dataDir, 'mqtt.crt');
  if (fs.existsSync(defaultKey) && fs.existsSync(defaultCert)) {
    try {
      return { key: fs.readFileSync(defaultKey), cert: fs.readFileSync(defaultCert) };
    } catch (err) {
      logger.warn({ err }, 'TLS certs found but unreadable, falling back to ws://');
      return null;
    }
  }

  return null;
}
