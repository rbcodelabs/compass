#!/usr/bin/env node
import getPrisma from '../lib/db';

interface TriageResult {
  feedbackId: string;
  title: string;
  description: string | null;
  votes: number;
  action: string;
  opportunityCreated?: string;
  solutionCreated?: boolean;
  assumptionCreated?: boolean;
}

const NOISE_KEYWORDS = ['test', 'spam', 'noise'];

function isLowQuality(feedback: {
  voteCount: number;
  description: string | null;
}): boolean {
  if (feedback.voteCount === 0) {
    if (!feedback.description || feedback.description.length < 5) {
      return true;
    }
    const description = feedback.description.toLowerCase();
    if (NOISE_KEYWORDS.some((kw) => description.includes(kw))) {
      return true;
    }
  }
  return false;
}

function isActionable(feedback: {
  voteCount: number;
  type: string;
  description: string | null;
}): boolean {
  return (
    feedback.voteCount >= 2 &&
    feedback.type === 'IDEA' &&
    feedback.description !== null &&
    feedback.description.length >= 10
  );
}

async function triageFeedback() {
  const prisma = getPrisma();
  const results: TriageResult[] = [];
  let linkedCount = 0;
  let createdCount = 0;
  let closedCount = 0;
  const createdOpportunities: string[] = [];
  let totalAssumptions = 0;

  try {
    const org = await prisma.organization.findUnique({
      where: { slug: 'rbcodelabs' },
    });

    if (!org) {
      console.error('Organization rbcodelabs not found');
      return;
    }

    const workspace = await prisma.workspace.findUnique({
      where: { organizationId_slug: { organizationId: org.id, slug: 'compass' } },
    });

    if (!workspace) {
      console.error('Workspace compass not found in organization rbcodelabs');
      return;
    }

    console.log(`Processing workspace: ${workspace.name} (${workspace.slug})`);
    console.log(`Organization: ${org.name} (${org.slug})`);

    const feedbackItems = await prisma.feedbackItem.findMany({
      where: {
        workspaceId: workspace.id,
        status: 'OPEN',
      },
      orderBy: [{ voteCount: 'desc' }, { createdAt: 'desc' }],
    });

    console.log(`Found ${feedbackItems.length} OPEN feedback items`);

    for (const feedback of feedbackItems) {
      let action = '';

      if (feedback.opportunityId) {
        action = 'UPDATED_TO_UNDER_REVIEW (already linked)';
        linkedCount++;
        await prisma.feedbackItem.update({
          where: { id: feedback.id },
          data: { status: 'UNDER_REVIEW' },
        });
      } else if (isActionable(feedback)) {
        const opportunity = await prisma.opportunity.create({
          data: {
            workspaceId: workspace.id,
            title: feedback.title,
            description: feedback.description || '',
            status: 'EXPLORING',
            source: 'MCP',
          },
        });

        const solution = await prisma.solution.create({
          data: {
            opportunityId: opportunity.id,
            title: `Solution: ${feedback.title}`,
            description: feedback.description || '',
            status: 'IDEA',
            source: 'MCP',
          },
        });

        const assumption = await prisma.assumption.create({
          data: {
            solutionId: solution.id,
            title: 'Validate customer value of this feedback',
            riskLevel: 'HIGH',
            status: 'UNTESTED',
            source: 'MCP',
          },
        });

        await prisma.feedbackItem.update({
          where: { id: feedback.id },
          data: {
            opportunityId: opportunity.id,
            status: 'UNDER_REVIEW',
          },
        });

        action = 'CREATED_OPPORTUNITY';
        createdCount++;
        totalAssumptions++;
        createdOpportunities.push(opportunity.title);

        results.push({
          feedbackId: feedback.id,
          title: feedback.title,
          description: feedback.description,
          votes: feedback.voteCount,
          action,
          opportunityCreated: opportunity.id,
          solutionCreated: true,
          assumptionCreated: true,
        });
        continue;
      } else if (isLowQuality(feedback)) {
        action = 'CLOSED_AS_NOISE';
        closedCount++;
        await prisma.feedbackItem.update({
          where: { id: feedback.id },
          data: { status: 'CLOSED' },
        });
      } else {
        action = 'UNDER_REVIEW (manual)';
        await prisma.feedbackItem.update({
          where: { id: feedback.id },
          data: { status: 'UNDER_REVIEW' },
        });
      }

      results.push({
        feedbackId: feedback.id,
        title: feedback.title,
        description: feedback.description,
        votes: feedback.voteCount,
        action,
      });
    }

    const report = buildReport(org, workspace, feedbackItems, results, linkedCount, createdCount, closedCount, createdOpportunities, totalAssumptions);

    const fs = await import('fs').then((m) => m.promises);
    await fs.writeFile('/Users/rickbowman/projects/compass/feedback-triage-report.md', report);

    console.log(`
${report}`);
    console.log(`
Report saved to: /Users/rickbowman/projects/compass/feedback-triage-report.md`);
  } catch (error) {
    console.error('Error during triage:', error);
  } finally {
    await prisma.$disconnect();
  }
}

function buildReport(org: any, workspace: any, feedbackItems: any[], results: TriageResult[], linkedCount: number, createdCount: number, closedCount: number, createdOpportunities: string[], totalAssumptions: number): string {
  const manualReviewCount = feedbackItems.length - linkedCount - createdCount - closedCount;
  
  let report = `# Feedback Triage Report

`;
  report += `## Summary

`;
  report += `- **Organization**: ${org.name} (slug: ${org.slug})
`;
  report += `- **Workspace**: ${workspace.name} (slug: ${workspace.slug})
`;
  report += `- **Report Generated**: ${new Date().toISOString()}

`;
  
  report += `## Results

`;
  report += `- **Total OPEN items processed**: ${feedbackItems.length}
`;
  report += `- **Items linked to existing opportunities**: ${linkedCount}
`;
  report += `- **New opportunities created**: ${createdCount}
`;
  report += `- **Items closed as noise**: ${closedCount}
`;
  report += `- **Items marked for manual review**: ${manualReviewCount}
`;
  report += `- **Total solutions created**: ${createdCount}
`;
  report += `- **Total HIGH-risk assumptions created**: ${totalAssumptions}

`;

  report += `## Created Opportunities

`;
  if (createdOpportunities.length > 0) {
    report += createdOpportunities.map((t) => `- ${t}`).join(`
`) + `

`;
  } else {
    report += `None

`;
  }

  report += `## Detailed Processing Log

`;
  report += `| Feedback ID | Title | Votes | Description Length | Action |
`;
  report += `|---|---|---|---|---|
`;
  for (const r of results) {
    const feedId = r.feedbackId.substring(0, 8);
    const title = r.title.substring(0, 40);
    const descLen = r.description ? r.description.length : 0;
    report += `| ${feedId}... | ${title} | ${r.votes} | ${descLen} | ${r.action} |
`;
  }

  report += `
## Action Breakdown

`;
  
  report += `### Created Opportunities (${createdCount})

`;
  const createdOppsByFeedback = results.filter((r) => r.opportunityCreated);
  for (const r of createdOppsByFeedback) {
    const solutionText = r.solutionCreated ? 'Yes' : 'No';
    const assumptionText = r.assumptionCreated ? 'Yes' : 'No';
    report += `- **${r.title}** (ID: ${r.opportunityCreated}, Votes: ${r.votes})
`;
    report += `  - Description: ${r.description || 'N/A'}
`;
    report += `  - Solution created: ${solutionText}
`;
    report += `  - HIGH-risk assumption created: ${assumptionText}

`;
  }

  report += `### Linked to Existing Opportunities (${linkedCount})

`;
  const linkedFeedback = results.filter((r) => r.action.includes('already linked'));
  for (const r of linkedFeedback) {
    report += `- **${r.title}** (Votes: ${r.votes})
`;
  }

  report += `
### Closed as Noise (${closedCount})

`;
  const closedFeedback = results.filter((r) => r.action === 'CLOSED_AS_NOISE');
  for (const r of closedFeedback) {
    const desc = r.description || 'empty';
    report += `- **${r.title}** (Votes: ${r.votes}, Description: ${desc})
`;
  }

  report += `
### Marked for Manual Review (${manualReviewCount})

`;
  const manualFeedback = results.filter((r) => r.action === 'UNDER_REVIEW (manual)');
  for (const r of manualFeedback) {
    const descLen = r.description ? r.description.length : 0;
    report += `- **${r.title}** (Votes: ${r.votes}, Description length: ${descLen})
`;
  }

  report += `
---

*Report generated by feedback-triage.ts*
`;
  
  return report;
}

triageFeedback();
