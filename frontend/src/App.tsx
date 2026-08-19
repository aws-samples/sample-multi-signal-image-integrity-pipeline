// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { useEffect, useMemo, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import AppLayout from '@cloudscape-design/components/app-layout';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Grid from '@cloudscape-design/components/grid';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Link from '@cloudscape-design/components/link';
import ProgressBar from '@cloudscape-design/components/progress-bar';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { useCollection } from '@cloudscape-design/collection-hooks';
import PipelineProgress from './PipelineProgress';
import {
  AnalysisRecord,
  completeNewPassword,
  currentUser,
  fetchResults,
  loadConfig,
  login,
  logout,
  startAnalysis,
  uploadImage,
} from './api';

const SIGNAL_LABELS: Record<string, string> = {
  bedrock_semantic: 'Semantic analysis (Amazon Bedrock)',
  ela: 'Error Level Analysis',
  fft: 'Frequency analysis',
  cross_evidence: 'Cross-evidence review',
  metadata: 'Metadata forensics',
};

const SIGNAL_ORDER = ['bedrock_semantic', 'ela', 'fft', 'cross_evidence', 'metadata'];

const PIPELINE_STEPS = [
  { label: 'Image submitted' },
  { label: 'Semantic analysis' },
  { label: 'Error Level Analysis' },
  { label: 'Frequency analysis' },
  { label: 'Metadata forensics' },
  { label: 'Cross-evidence review' },
  { label: 'Risk aggregation' },
  { label: 'Verdict' },
];

const CHECK_LABELS: Record<string, string> = {
  usability: 'Usability check failed',
  authenticity: 'Authenticity check failed',
};

function useAnalysisProgress(running: boolean, done: boolean) {
  // The first four signals run in parallel. The stepper advances on a timer to
  // show roughly where the pipeline is; it does not poll each branch.
  const [step, setStep] = useState(-1);
  useEffect(() => {
    if (done) {
      setStep(PIPELINE_STEPS.length);
      return;
    }
    if (!running) {
      setStep(-1);
      return;
    }
    setStep(0);
    const timer = setInterval(
      () => setStep((s) => Math.min(s + 1, PIPELINE_STEPS.length - 2)),
      900,
    );
    return () => clearInterval(timer);
  }, [running, done]);
  return step;
}

function VerdictBadge({ verdict }: { verdict: string }) {
  return verdict === 'FLAG' ? <Badge color="red">FLAG</Badge> : <Badge color="green">PASS</Badge>;
}

function SignalMini({ record, name }: { record: AnalysisRecord; name: string }) {
  const signal = record.signals[name];
  if (!signal) return <StatusIndicator type="stopped">n/a</StatusIndicator>;
  return signal.verdict === 'flag' ? (
    <StatusIndicator type="warning">flag</StatusIndicator>
  ) : (
    <StatusIndicator type="success">pass</StatusIndicator>
  );
}

function scorePercent(value: string): number {
  return Math.round(Math.min(Math.max(parseFloat(value) || 0, 0), 1) * 100);
}

function FindingItem({ name, signal }: { name: string; signal: AnalysisRecord['signals'][string] }) {
  const flagged = signal.verdict === 'flag';
  return (
    <div>
      <SpaceBetween size="xxs">
        <SpaceBetween direction="horizontal" size="xs" alignItems="center">
          {flagged ? (
            <StatusIndicator type="warning">{SIGNAL_LABELS[name] ?? name}</StatusIndicator>
          ) : (
            <StatusIndicator type="success">{SIGNAL_LABELS[name] ?? name}</StatusIndicator>
          )}
          {flagged && signal.failedCheck && (
            <Badge color="severity-medium">{signal.failedCheck}</Badge>
          )}
        </SpaceBetween>
        <ProgressBar
          value={scorePercent(signal.score)}
          variant="key-value"
          ariaLabel={`${SIGNAL_LABELS[name] ?? name} risk contribution`}
        />
        <Box variant="small" color="text-body-secondary">
          {signal.rationale}
        </Box>
      </SpaceBetween>
    </div>
  );
}

function ImageDetail({ record, onBack }: { record: AnalysisRecord; onBack: () => void }) {
  const filename = record.sk.split('/').pop() ?? record.sk;
  const flagged = record.verdict === 'FLAG';
  const riskPercent = scorePercent(record.weightedScore);

  // Evidence views: the submitted image plus any artefacts the signals generated.
  const views = useMemo(() => {
    const list: { id: string; text: string; url?: string; caption: string }[] = [
      {
        id: 'original',
        text: 'Original',
        url: record.imageUrl,
        caption: 'The submitted image, as received.',
      },
    ];
    if (record.signals.ela?.artifactUrl) {
      list.push({
        id: 'ela',
        text: 'ELA heatmap',
        url: record.signals.ela.artifactUrl,
        caption:
          'Error Level Analysis. Bright regions recompress differently from the rest of the image. A contiguous bright area that does not follow a texture edge indicates pasted content.',
      });
    }
    if (record.signals.fft?.artifactUrl) {
      list.push({
        id: 'fft',
        text: 'Frequency spectrum',
        url: record.signals.fft.artifactUrl,
        caption:
          'Log power spectrum. Photographs decay smoothly from the centre. Periodic spikes or a grid structure indicate synthetic generation.',
      });
    }
    return list;
  }, [record]);

  const [viewId, setViewId] = useState('original');
  const view = views.find((v) => v.id === viewId) ?? views[0];

  const flaggedSignals = SIGNAL_ORDER.filter((n) => record.signals[n]?.verdict === 'flag');
  const totalSignals = SIGNAL_ORDER.filter((n) => record.signals[n]).length;
  const failedCheck = record.signals.bedrock_semantic?.failedCheck;
  const headline = flagged
    ? (failedCheck && CHECK_LABELS[failedCheck]) || 'Flagged for review'
    : 'Cleared by all signals';

  // What the verdict rests on. Two of the five signals ask a model to judge the submitted
  // image, so text embedded in that image can influence them; the deterministic signals
  // cannot read instructions but also cannot see a cleanly generated forgery. A reviewer
  // needs both halves of that to weigh the result.
  const caveat = !flagged
    ? 'A pass is not proof of authenticity. The two model signals carry 40% of the verdict weight and read the submitted image, so text embedded in that image can influence them, and the deterministic signals cannot detect a cleanly generated forgery. Do not treat a pass as an automated clearance.'
    : record.corroboration === 'llm_only'
      ? 'This finding rests only on the model signals, with no deterministic corroboration. Those signals read the submitted image, so confirm the finding against the evidence below before acting on it.'
      : null;

  return (
    <SpaceBetween size="l">
      <BreadcrumbGroup
        items={[
          { text: 'Review queue', href: '#' },
          { text: filename, href: '#' },
        ]}
        onFollow={(e) => {
          e.preventDefault();
          if (e.detail.text === 'Review queue') onBack();
        }}
      />

      <Container
        header={
          <Header
            variant="h1"
            actions={<Button onClick={onBack}>Back to queue</Button>}
            description={`Analyzed ${new Date(record.analyzedAt).toLocaleString()}`}
          >
            {filename}
          </Header>
        }
      >
        <SpaceBetween size="l">
          <Alert type={flagged ? 'warning' : 'success'} header={headline}>
            {flagged
              ? `${flaggedSignals.length} of ${totalSignals} signals raised findings. Review the evidence below before accepting this image.`
              : 'No signal raised a finding.'}
            {caveat && (
              <Box variant="small" color="text-body-secondary" padding={{ top: 'xs' }}>
                {caveat}
              </Box>
            )}
          </Alert>

          <KeyValuePairs
            columns={4}
            items={[
              { label: 'Verdict', value: <VerdictBadge verdict={record.verdict} /> },
              {
                label: 'Weighted risk score',
                value: (
                  <ProgressBar
                    value={riskPercent}
                    variant="key-value"
                    ariaLabel="Weighted risk score"
                  />
                ),
              },
              { label: 'Signals flagged', value: `${flaggedSignals.length} of ${totalSignals}` },
              { label: 'Image key', value: <Box variant="code">{record.sk}</Box> },
              // The two group scores are what actually decide the verdict; the weighted
              // score above is the whole-pipeline sum, kept for continuity.
              {
                label: 'Deterministic group',
                value: record.deterministicScore ? (
                  <ProgressBar
                    value={scorePercent(record.deterministicScore)}
                    variant="key-value"
                    ariaLabel="Deterministic signal group score"
                  />
                ) : (
                  <StatusIndicator type="stopped">n/a</StatusIndicator>
                ),
              },
              {
                label: 'Model group',
                value: record.llmScore ? (
                  <ProgressBar
                    value={scorePercent(record.llmScore)}
                    variant="key-value"
                    ariaLabel="Model signal group score"
                  />
                ) : (
                  <StatusIndicator type="stopped">n/a</StatusIndicator>
                ),
              },
            ]}
          />
        </SpaceBetween>
      </Container>

      <Grid gridDefinition={[{ colspan: { default: 12, s: 7 } }, { colspan: { default: 12, s: 5 } }]}>
        <Container
          header={
            <Header
              variant="h2"
              actions={
                views.length > 1 && (
                  <SegmentedControl
                    selectedId={viewId}
                    onChange={({ detail }) => setViewId(detail.selectedId)}
                    label="Evidence view"
                    options={views.map(({ id, text }) => ({ id, text }))}
                  />
                )
              }
            >
              Evidence
            </Header>
          }
        >
          <SpaceBetween size="s">
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                minHeight: 480,
                alignItems: 'center',
              }}
            >
              {view.url ? (
                <img
                  src={view.url}
                  alt={`${view.text} view of ${filename}`}
                  style={{ maxWidth: '100%', maxHeight: 620, borderRadius: 8, objectFit: 'contain' }}
                />
              ) : (
                <Box color="text-body-secondary">Image unavailable</Box>
              )}
            </div>
            <Box variant="small" color="text-body-secondary" textAlign="center">
              {view.caption}
            </Box>
          </SpaceBetween>
        </Container>

        <Container
          header={
            <Header variant="h2" counter={`(${totalSignals})`}>
              Signal findings
            </Header>
          }
        >
          <SpaceBetween size="l">
            {SIGNAL_ORDER.filter((n) => record.signals[n])
              .sort((a, b) => {
                const flagA = record.signals[a].verdict === 'flag' ? 0 : 1;
                const flagB = record.signals[b].verdict === 'flag' ? 0 : 1;
                return (
                  flagA - flagB ||
                  parseFloat(record.signals[b].score) - parseFloat(record.signals[a].score)
                );
              })
              .map((name) => (
                <FindingItem key={name} name={name} signal={record.signals[name]} />
              ))}
          </SpaceBetween>
        </Container>
      </Grid>
    </SpaceBetween>
  );
}

function ReviewQueue() {
  const [records, setRecords] = useState<AnalysisRecord[]>([]);
  const [openRecord, setOpenRecord] = useState<AnalysisRecord | null>(null);
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [analysisDone, setAnalysisDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const progressStep = useAnalysisProgress(analyzing !== null, analysisDone);

  const refresh = async () => {
    const items = await fetchResults();
    setRecords(items);
    return items;
  };

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
  }, []);

  const runAnalysis = async (imageKey: string) => {
    setAnalyzing(imageKey);
    setAnalysisDone(false);
    await startAnalysis(imageKey);
    const poll = setInterval(async () => {
      const items = await refresh();
      const hit = items.find((r) => r.sk === imageKey);
      if (hit) {
        clearInterval(poll);
        setAnalysisDone(true);
        setTimeout(() => {
          setAnalyzing(null);
          setOpenRecord(hit);
        }, 1200);
      }
    }, 2000);
  };

  const onUpload = async (file: File) => {
    try {
      const key = await uploadImage(file);
      await runAnalysis(key);
    } catch (e) {
      setError(String(e));
      setAnalyzing(null);
    }
  };

  const { items, collectionProps } = useCollection(records, {
    sorting: {
      defaultState: {
        sortingColumn: { sortingField: 'weightedScore' },
        isDescending: true,
      },
    },
  });

  if (openRecord) {
    return <ImageDetail record={openRecord} onBack={() => setOpenRecord(null)} />;
  }

  return (
    <SpaceBetween size="l">
      {error && (
        <Alert type="error" dismissible onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}
      {analyzing && (
        <PipelineProgress
          title="Analysis progress"
          steps={PIPELINE_STEPS}
          activeIndex={progressStep}
        />
      )}
      <Table
        {...collectionProps}
        items={items}
        trackBy="sk"
        variant="container"
        onRowClick={({ detail }) => setOpenRecord(detail.item)}
        header={
          <Header
            variant="h2"
            counter={`(${records.length})`}
            description="Images scored by the integrity pipeline. Select a row for the per-signal breakdown."
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  iconName="refresh"
                  onClick={() => refresh().catch((e) => setError(String(e)))}
                >
                  Refresh
                </Button>
                <Button iconName="upload">
                  <label style={{ cursor: 'pointer' }}>
                    Upload image
                    <input
                      type="file"
                      accept=".jpg,.jpeg,.png"
                      style={{ display: 'none' }}
                      onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
                    />
                  </label>
                </Button>
              </SpaceBetween>
            }
          >
            Review queue
          </Header>
        }
        columnDefinitions={[
          {
            id: 'image',
            header: 'Image',
            cell: (item) =>
              item.imageUrl ? (
                <img
                  src={item.imageUrl}
                  alt={item.sk}
                  style={{ width: 48, height: 64, objectFit: 'cover', borderRadius: 4 }}
                />
              ) : null,
          },
          {
            id: 'filename',
            header: 'Filename',
            sortingField: 'sk',
            cell: (item) => (
              <Link
                href="#"
                onFollow={(e) => {
                  e.preventDefault();
                  setOpenRecord(item);
                }}
              >
                {item.sk.split('/').pop()}
              </Link>
            ),
          },
          {
            id: 'verdict',
            header: 'Verdict',
            sortingField: 'verdict',
            cell: (item) => <VerdictBadge verdict={item.verdict} />,
          },
          {
            id: 'score',
            header: 'Risk score',
            sortingField: 'weightedScore',
            cell: (item) => item.weightedScore,
          },
          {
            id: 'bedrock',
            header: 'Semantic',
            cell: (item) => <SignalMini record={item} name="bedrock_semantic" />,
          },
          { id: 'ela', header: 'ELA', cell: (item) => <SignalMini record={item} name="ela" /> },
          { id: 'fft', header: 'FFT', cell: (item) => <SignalMini record={item} name="fft" /> },
          {
            id: 'cross_evidence',
            header: 'Cross-ev.',
            cell: (item) => <SignalMini record={item} name="cross_evidence" />,
          },
          {
            id: 'metadata',
            header: 'Metadata',
            cell: (item) => <SignalMini record={item} name="metadata" />,
          },
          {
            id: 'finding',
            header: 'Top finding',
            maxWidth: 320,
            cell: (item) => {
              const flagged = SIGNAL_ORDER.map((n) => item.signals[n])
                .filter(Boolean)
                .find((s) => s.verdict === 'flag');
              return flagged ? (
                <Box variant="small">{flagged.rationale.slice(0, 110)}…</Box>
              ) : (
                <Box variant="small" color="text-body-secondary">
                  No findings
                </Box>
              );
            },
          },
        ]}
        empty={
          <Box textAlign="center" color="inherit">
            <b>No results yet</b>
            <Box variant="p" color="inherit">
              Run the seed script, then choose Refresh.
            </Box>
          </Box>
        }
      />
    </SpaceBetween>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [needsNewPassword, setNeedsNewPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (needsNewPassword) {
        await completeNewPassword(newPassword);
        onSignedIn();
        return;
      }
      const step = await login(username, password);
      if (step === 'newPasswordRequired') {
        setNeedsNewPassword(true);
        return;
      }
      onSignedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box padding={{ top: 'xxl' }}>
      <Grid gridDefinition={[{ colspan: { default: 12, s: 6 }, offset: { default: 0, s: 3 } }]}>
        <Container header={<Header variant="h2">Sign in</Header>}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <Form
              actions={
                <Button variant="primary" loading={busy} onClick={submit}>
                  {needsNewPassword ? 'Set password' : 'Sign in'}
                </Button>
              }
              errorText={error}
            >
              <SpaceBetween size="m">
                {needsNewPassword ? (
                  <FormField
                    label="New password"
                    description="At least 12 characters, with upper and lower case, a digit, and a symbol."
                  >
                    <Input
                      type="password"
                      value={newPassword}
                      onChange={({ detail }) => setNewPassword(detail.value)}
                    />
                  </FormField>
                ) : (
                  <>
                    <FormField label="Email">
                      <Input
                        type="email"
                        value={username}
                        onChange={({ detail }) => setUsername(detail.value)}
                      />
                    </FormField>
                    <FormField label="Password">
                      <Input
                        type="password"
                        value={password}
                        onChange={({ detail }) => setPassword(detail.value)}
                      />
                    </FormField>
                  </>
                )}
              </SpaceBetween>
            </Form>
          </form>
        </Container>
      </Grid>
    </Box>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<string | null>(null);

  useEffect(() => {
    loadConfig()
      .then(currentUser)
      .then((name) => {
        setUser(name);
        setReady(true);
      });
  }, []);

  if (!ready) return null;

  if (!user) {
    return (
      <AppLayout
        navigationHide
        toolsHide
        content={
          <ContentLayout
            header={
              <Header variant="h1" description="Sign in to review scored images.">
                Image integrity review
              </Header>
            }
          >
            <SignIn onSignedIn={() => currentUser().then(setUser)} />
          </ContentLayout>
        }
      />
    );
  }

  return (
    <AppLayout
      navigationHide
      toolsHide
      content={
        <ContentLayout
          header={
            <Header
              variant="h1"
              description="Five signals score each image and explain what they found."
              actions={<Button onClick={() => logout().then(() => setUser(null))}>Sign out</Button>}
            >
              Image integrity review
            </Header>
          }
        >
          <ReviewQueue />
        </ContentLayout>
      }
    />
  );
}
