import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Btn, Card, Pill, Row, Screen } from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';

type QueueStatus = 'waiting' | 'ready' | 'seated';

interface QueueEntry {
  id: string;
  queueNumber: string;
  partySize: number;
  estimatedWaitMinutes: number;
  status: QueueStatus;
}

/** Mock queue entry — Meituan-style waiting list placeholder.
 * In production this would come from a queue repository (GET /queue/{id}),
 * but for now the screen shows static mock data. */
const MOCK_QUEUE: QueueEntry = {
  id: 'queue_demo_001',
  queueNumber: 'A12',
  partySize: 4,
  estimatedWaitMinutes: 15,
  status: 'waiting',
};

function statusTone(status: QueueStatus): 'warning' | 'success' | 'info' {
  if (status === 'ready') return 'success';
  if (status === 'seated') return 'info';
  return 'warning';
}

function statusLabel(status: QueueStatus): string {
  if (status === 'ready') return 'Ready';
  if (status === 'seated') return 'Seated';
  return 'Waiting';
}

export default function QueueScreen() {
  const router = useRouter();
  const { queueId } = useLocalSearchParams<{ queueId: string }>();
  const [status, setStatus] = useState<QueueStatus>(MOCK_QUEUE.status);

  const queue: QueueEntry = {
    ...MOCK_QUEUE,
    id: typeof queueId === 'string' && queueId.length > 0 ? queueId : MOCK_QUEUE.id,
    status,
  };

  return (
    <Screen>
      <View style={{ padding: Spacing.lg, gap: Spacing.lg }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Btn label="Back" onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title}>Queue</Text>
          <View style={{ width: 80 }} />
        </Row>

        <Card>
          <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
            <Text style={styles.label}>Queue number</Text>
            <Pill label={statusLabel(queue.status)} tone={statusTone(queue.status)} />
          </Row>
          <Text style={styles.queueNumber}>{queue.queueNumber}</Text>
          <Text style={styles.meta}>Queue ID: {queue.id}</Text>

          <View style={styles.divider} />

          <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.sm }}>
            <Text style={styles.label}>Party size</Text>
            <Text style={styles.value}>{queue.partySize} people</Text>
          </Row>
          <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.sm }}>
            <Text style={styles.label}>Estimated wait</Text>
            <Text style={styles.value}>{queue.estimatedWaitMinutes} min</Text>
          </Row>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.label}>Status</Text>
            <Text style={[styles.value, styles.statusText]}>{statusLabel(queue.status)}</Text>
          </Row>
        </Card>

        <Card style={{ gap: Spacing.md }}>
          <Text style={styles.section}>Live status</Text>
          <Text style={styles.meta}>
            You are in the waiting list. We will notify you when your table is ready. Please stay nearby.
          </Text>
          {/* Demo helper to cycle through the three statuses */}
          <Row gap={Spacing.sm}>
            <Btn
              label="Waiting"
              onPress={() => setStatus('waiting')}
              variant={status === 'waiting' ? 'primary' : 'outline'}
              size="sm"
              style={{ flex: 1 }}
            />
            <Btn
              label="Ready"
              onPress={() => setStatus('ready')}
              variant={status === 'ready' ? 'primary' : 'outline'}
              size="sm"
              style={{ flex: 1 }}
            />
            <Btn
              label="Seated"
              onPress={() => setStatus('seated')}
              variant={status === 'seated' ? 'primary' : 'outline'}
              size="sm"
              style={{ flex: 1 }}
            />
          </Row>
        </Card>

        {status === 'ready' ? (
          <Card style={{ backgroundColor: Colors.successSoft }}>
            <Text style={{ color: Colors.success, fontFamily: Fonts.sansBold, fontSize: FontSize.md }}>
              Your table is ready! Please head to the restaurant.
            </Text>
          </Card>
        ) : null}

        {status === 'seated' ? (
          <Card style={{ backgroundColor: Colors.infoSoft }}>
            <Text style={{ color: Colors.info, fontFamily: Fonts.sansBold, fontSize: FontSize.md }}>
              You have been seated — enjoy your meal!
            </Text>
          </Card>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansExtraBold, color: Colors.text, textAlign: 'center', flex: 1 },
  label: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansMedium },
  queueNumber: { fontSize: 42, fontFamily: Fonts.sansExtraBold, color: Colors.text, textAlign: 'center', letterSpacing: 2 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, textAlign: 'center', marginTop: 4 },
  value: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansSemibold },
  statusText: { textTransform: 'capitalize' },
  section: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border, marginVertical: Spacing.md },
});
