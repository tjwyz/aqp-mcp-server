import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { logger } from './logger.js';

// Map to store active SSE transport sessions
export class TransportManager {
  private transportSessions = new Map<string, SSEServerTransport>();
  
  registerTransportSession(transport: SSEServerTransport): void {
    this.transportSessions.set(transport.sessionId, transport);
    transport.onclose = () => {
      this.transportSessions.delete(transport.sessionId);
      logger.info('[SSE] Transport session closed:', { sessionId: transport.sessionId });
    };
    logger.info('[SSE] Transport session registered:', { sessionId: transport.sessionId });
  }
  
  getTransportForSession(sessionId: string): SSEServerTransport | undefined {
    const transport = this.transportSessions.get(sessionId);
    if (!transport) {
      logger.debug('[SSE] Transport session not found:', { sessionId });
    }
    return transport;
  }
  
  getAllSessions(): Map<string, SSEServerTransport> {
    return this.transportSessions;
  }
}