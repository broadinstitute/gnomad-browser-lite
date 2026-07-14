import { useEffect, useMemo, useState } from 'react';
import styled from 'styled-components';
import { api } from '../api/client';
import type { QCReport, QCTier } from '../api/types';
import { useBranding } from '../contexts/BrandingContext';
import { CHECK_CATALOG, TIERS, catalogByTier } from '../qc/checkCatalog';
import { QCStepper, type TierProgress } from '../components/qc/QCStepper';
import { QCCheckCard } from '../components/qc/QCCheckCard';

const Page = styled.div`
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem 1.5rem 4rem;
`;

const Header = styled.header`
  border-bottom: 1px solid #eee;
  padding-bottom: 1.25rem;
  margin-bottom: 1.5rem;
`;

const TitleRow = styled.div`
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  flex-wrap: wrap;
`;

const Title = styled.h1`
  margin: 0;
  font-size: 1.6rem;
`;

const Subtitle = styled.p`
  margin: 0.4rem 0 0;
  color: #666;
  font-size: 0.95rem;
`;

const MetaLine = styled.div`
  margin-top: 0.9rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 1.5rem;
  font-size: 13px;
  color: #555;

  strong {
    color: #333;
  }

  code {
    font-size: 12px;
    color: #444;
  }
`;

const SummaryChips = styled.div`
  margin-top: 1rem;
  display: flex;
  gap: 0.6rem;
  flex-wrap: wrap;
`;

const SummaryChip = styled.div<{ $bg: string; $fg: string }>`
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  background: ${(p) => p.$bg};
  color: ${(p) => p.$fg};
  border-radius: 8px;
  padding: 0.5rem 0.9rem;
  font-size: 13px;
  font-weight: 600;

  strong {
    font-size: 1.15rem;
  }
`;

const Layout = styled.div`
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 1.75rem;
  align-items: start;

  @media (max-width: 860px) {
    grid-template-columns: 1fr;
  }
`;

const Panel = styled.section`
  /* Prevent a wide examples table from blowing out the 1fr grid column
     (grid items default to min-width: auto). */
  min-width: 0;
`;

const PanelHeader = styled.div`
  margin-bottom: 1rem;
`;

const PanelTitle = styled.h2`
  margin: 0;
  font-size: 1.25rem;
`;

const PanelSubtitle = styled.p`
  margin: 0.3rem 0 0;
  color: #777;
  font-size: 0.9rem;
`;

const FutureNotice = styled.div`
  margin-bottom: 1rem;
  background: #f7f9fc;
  border: 1px solid #e6ebf2;
  border-radius: 8px;
  padding: 0.75rem 1rem;
  font-size: 13px;
  color: #556;
`;

const CardList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
`;

const StateBox = styled.div`
  max-width: 640px;
  margin: 3rem auto;
  text-align: center;
  color: #555;
`;

const CommandBlock = styled.pre`
  margin-top: 1rem;
  background: #1e1e1e;
  color: #e6e6e6;
  padding: 0.9rem 1.1rem;
  border-radius: 8px;
  text-align: left;
  overflow-x: auto;
  font-size: 13px;
`;

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function QCReportPage() {
  const branding = useBranding();
  const [report, setReport] = useState<QCReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentTier, setCurrentTier] = useState<QCTier>(1);

  useEffect(() => {
    let cancelled = false;
    api
      .getQCReport()
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch(() => {
        if (!cancelled) setReport(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Map results by id for the catalog ∪ report render.
  const resultById = useMemo(() => {
    const m = new Map<string, QCReport['checks'][number]>();
    for (const c of report?.checks ?? []) m.set(c.id, c);
    return m;
  }, [report]);

  // Per-tier progress for the stepper.
  const progress = useMemo(() => {
    const acc: Record<number, TierProgress> = {};
    for (const t of TIERS) {
      acc[t.tier] = { total: 0, implemented: 0, pass: 0, warn: 0, fail: 0 };
    }
    for (const cat of CHECK_CATALOG) {
      const p = acc[cat.tier];
      p.total += 1;
      const res = resultById.get(cat.id);
      if (res) {
        p.implemented += 1;
        if (res.status === 'pass') p.pass += 1;
        else if (res.status === 'warn') p.warn += 1;
        else if (res.status === 'fail') p.fail += 1;
      }
    }
    return acc;
  }, [resultById]);

  const tierMeta = TIERS.find((t) => t.tier === currentTier)!;
  const tierChecks = catalogByTier(currentTier);

  if (loading) {
    return (
      <Page>
        <StateBox>Loading QC report…</StateBox>
      </Page>
    );
  }

  const datasetName = branding.full_title || branding.short_name || branding.name;

  return (
    <Page>
      <Header>
        <TitleRow>
          <Title>QC validity report</Title>
        </TitleRow>
        <Subtitle>{datasetName} — technical &amp; biological validity checks</Subtitle>

        {report ? (
          <>
            <MetaLine>
              {report.dataset_id && (
                <span>
                  <strong>Dataset:</strong> {report.dataset_id}
                </span>
              )}
              <span>
                <strong>Source:</strong> <code>{report.source}</code>
              </span>
              {report.reference_genome && (
                <span>
                  <strong>Reference:</strong> {report.reference_genome}
                </span>
              )}
              <span>
                <strong>Rows scanned:</strong> {report.rows_scanned.toLocaleString()}
              </span>
              <span>
                <strong>Generated:</strong> {formatTimestamp(report.generated_at)}
              </span>
            </MetaLine>
            <SummaryChips>
              <SummaryChip $bg="#e6f4ea" $fg="#1e7e34">
                <strong>{report.summary.pass}</strong> pass
              </SummaryChip>
              <SummaryChip $bg="#fff4e0" $fg="#a56100">
                <strong>{report.summary.warn}</strong> warn
              </SummaryChip>
              <SummaryChip $bg="#fdeaea" $fg="#c62828">
                <strong>{report.summary.fail}</strong> fail
              </SummaryChip>
            </SummaryChips>
          </>
        ) : (
          <MetaLine>
            <span>No report loaded — showing the full check flow as a preview.</span>
          </MetaLine>
        )}
      </Header>

      {!report && (
        <StateBox>
          <p>
            No QC report is configured yet. Generate one by running the validity checks over your
            sites file:
          </p>
          <CommandBlock>gbl qc run &lt;your-sites-file&gt; --out report.json</CommandBlock>
          <p style={{ marginTop: '1rem', fontSize: '0.9rem', color: '#777' }}>
            Then point the backend at it via <code>[qc] report_path</code> in{' '}
            <code>gbl.toml</code>. The flow below shows every check that report will fill in.
          </p>
        </StateBox>
      )}

      <Layout>
        <QCStepper
          tiers={TIERS}
          progress={progress}
          currentTier={currentTier}
          onSelect={setCurrentTier}
        />

        <Panel>
          <PanelHeader>
            <PanelTitle>
              Tier {tierMeta.tier} — {tierMeta.title}
            </PanelTitle>
            <PanelSubtitle>{tierMeta.subtitle}</PanelSubtitle>
          </PanelHeader>

          {tierMeta.future && (
            <FutureNotice>
              Cross-partner checks run centrally over multiple submitted reports with{' '}
              <code>gbl qc cross</code>. They are sketched here so the whole flow is visible; the
              cards below describe what each will report.
            </FutureNotice>
          )}

          <CardList>
            {tierChecks.map((cat) => (
              <QCCheckCard key={cat.id} catalog={cat} result={resultById.get(cat.id)} />
            ))}
          </CardList>
        </Panel>
      </Layout>
    </Page>
  );
}

export default QCReportPage;
