import { DWClient, type DWClientDownStream, EventAck } from 'dingtalk-stream';
import { getConfig } from '../config/index.js';
import { enqueueApprovalEvent } from '../kafka/event-outbox.js';
import { streamEventSchema } from './types.js';

let client: any = null;

function createEventMessage(params: {
  eventType: string;
  corpId: string;
  processInstanceId: string;
  processCode?: string;
  eventId: string;
  payload: Record<string, unknown>;
}): {
  eventType: string;
  corpId: string;
  processInstanceId: string;
  processCode?: string;
  eventId: string;
  payload: Record<string, unknown>;
  source: string;
  receivedAt: string;
} {
  return {
    ...params,
    source: 'stream',
    receivedAt: new Date().toISOString(),
  };
}

export async function startStreamListener(): Promise<void> {
  const config = getConfig();

  client = new DWClient({
    clientId: config.DINGTALK_APP_KEY,
    clientSecret: config.DINGTALK_APP_SECRET,
    debug: true,
  });

  client.registerCallbackListener('/bpms/instance_change', async (event: any) => {
    try {
      const parsed = streamEventSchema.parse(JSON.parse(event.data));
      if (!parsed.ProcessInstanceId) throw new Error('instance_change event has no processInstanceId');
      const eventId = parsed.EventId
        || `${parsed.CorpId}:${parsed.ProcessInstanceId}:${parsed.EventType}:${parsed.TimeStamp || ''}`;

      await enqueueApprovalEvent(createEventMessage({
        eventType: 'bpms_instance_change',
        corpId: parsed.CorpId,
        processInstanceId: parsed.ProcessInstanceId,
        processCode: parsed.ProcessCode,
        eventId,
        payload: parsed,
      }));
    } catch (error) {
      console.error('[StreamListener] instance_change event persistence failed:', error);
    }
  });

  client.registerCallbackListener('/bpms/task_change', async (event: any) => {
    try {
      const parsed = streamEventSchema.parse(JSON.parse(event.data));
      if (!parsed.ProcessInstanceId) throw new Error('task_change event has no processInstanceId');
      const eventId = parsed.EventId
        || `${parsed.CorpId}:${parsed.ProcessInstanceId}:${parsed.EventType}:${parsed.TimeStamp || ''}`;

      await enqueueApprovalEvent(createEventMessage({
        eventType: 'bpms_task_change',
        corpId: parsed.CorpId,
        processInstanceId: parsed.ProcessInstanceId,
        processCode: parsed.ProcessCode,
        eventId,
        payload: parsed,
      }));
    } catch (error) {
      console.error('[StreamListener] task_change event persistence failed:', error);
    }
  });

  // Catch event messages as a fallback for event types delivered outside callbacks.
  client.registerAllEventListener((message: DWClientDownStream) => {
    const eventType = message.headers?.eventType;
    const eventCorpId = message.headers?.eventCorpId;
    const messageId = message.headers?.messageId;

    if (eventType && eventCorpId && (eventType.includes('bpms') || eventType.includes('process'))) {
      try {
        const data = JSON.parse(message.data) as Record<string, any>;
        const processInstanceId = data.processInstanceId || data.ProcessInstanceId;
        const processCode = data.processCode || data.ProcessCode;
        const actionType = data.type || data.Type;
        const eventId = data.EventId
          || messageId
          || `${eventCorpId}:${processInstanceId}:${eventType}:${data.TimeStamp || ''}`;

        if (processInstanceId) {
          console.log('[StreamListener] approval event:', {
            eventCorpId,
            processInstanceId,
            eventType,
            actionType,
          });

          void enqueueApprovalEvent(createEventMessage({
            eventType,
            corpId: eventCorpId,
            processInstanceId,
            processCode,
            eventId,
            payload: data,
          })).catch((error: any) => {
            console.error('[StreamListener] fallback event persistence failed:', error?.message || error);
          });
        }
      } catch {
        // Ignore non-JSON stream messages.
      }
    }

    return { status: EventAck.SUCCESS };
  });

  client.on('disconnect', () => {
    console.warn('[StreamListener] connection disconnected; reconnecting');
  });

  client.on('reconnect', () => {
    console.log('[StreamListener] reconnected');
  });

  await client.connect();
  console.log('[StreamListener] Stream connected');
}

export async function stopStreamListener(): Promise<void> {
  if (client) {
    await client.disconnect();
    client = null;
    console.log('[StreamListener] Stream connection closed');
  }
}
