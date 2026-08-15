export interface WidgetHelpUseCase {
  scenario: string;
  signal: string;
}

export interface WidgetHelp {
  howToRead: string;
  whatToLookFor: string[];
  useCases: WidgetHelpUseCase[];
}

// CTO-facing help, keyed by widget `type`. Content is authored against what each
// widget actually computes. Widgets without an entry render no help icon.
export const WIDGET_HELP: Record<string, WidgetHelp> = {
  DORA_METRICS: {
    howToRead:
      'Four industry-standard DORA metrics — Lead Time for Changes, Deploy Frequency, Change Failure Rate, and Time to Restore — each badged Elite/High/Medium/Low against the DX 2025 benchmarks. Lead Time is measured directly; Deploy Frequency, Change Failure Rate, and Time to Restore are proxied from merge/revert/fix activity because no deployment or incident source is connected yet, so treat those three as directional.',
    whatToLookFor: [
      'Any tile sitting at Medium or Low — that is your weakest link in the delivery pipeline.',
      'A Lead Time tier worse than the others usually points at slow review or big batches, not slow coding.',
      'Because DF/CFR/MTTR are proxies, watch their trend over time rather than the absolute tier.',
    ],
    useCases: [
      {
        scenario: 'The board looks busy but shipping feels slow',
        signal:
          'Lead Time is High or Medium while the other tiles look fine — the bottleneck is between commit and merge, not effort.',
      },
      {
        scenario: 'Leadership wants a one-glance delivery grade',
        signal:
          'Read the mix of tiers across the four tiles; three greens and one amber is a healthy team with one fixable constraint.',
      },
    ],
  },
  LEAD_TIME_FOR_CHANGES: {
    howToRead:
      'Each point is the median (p50) hours from a change’s first commit to its PR being merged, plotted weekly. Lower is better; the shaded bands mark the Elite/High/Medium/Low benchmark thresholds.',
    whatToLookFor: [
      'The trend direction — a line drifting upward week over week means changes take longer to land.',
      'Which benchmark band the recent weeks sit in.',
      'Spikes that coincide with big releases or team changes.',
    ],
    useCases: [
      {
        scenario: 'The review process is silently slowing down',
        signal:
          'The p50 line climbs for three or more consecutive weeks while commit volume stays flat.',
      },
      {
        scenario: 'A process change actually helped',
        signal:
          'The line steps down and stays down after you introduced smaller PRs or a review SLA.',
      },
    ],
  },
  PR_CYCLE_TIME_SCATTER: {
    howToRead:
      'Every dot is a single merged PR: horizontal position is when it merged, vertical is how many hours it took end to end, and colour is its benchmark tier. Click a dot to drill into that author’s PRs.',
    whatToLookFor: [
      'Vertical outliers — a few dots far above the pack are the PRs that dragged your average.',
      'Colour: lots of amber/red dots mean cycle time is systemic, not a one-off.',
      'Time clusters — a wall of slow dots in one week points at a review or release crunch.',
    ],
    useCases: [
      {
        scenario: 'One giant PR skewed the weekly average',
        signal: 'A single dot sits far above the rest; click it to see the outsized change.',
      },
      {
        scenario: 'A specific author is stuck',
        signal:
          'Click a high dot and the drill-through shows the same author repeatedly in the slow band.',
      },
    ],
  },
  REVIEW_PICKUP_TIME: {
    howToRead:
      'The average hours a PR waits from being opened until its first review, plotted weekly. Lower is better; shaded bands show the benchmark tiers. This isolates review latency from coding and rework time.',
    whatToLookFor: [
      'A rising line — reviewers are slower to pick up work, often the first symptom of overload.',
      'Which benchmark band recent weeks fall in — aim for the Elite band.',
      'Pickup time worsening even as PR volume stays flat.',
    ],
    useCases: [
      {
        scenario: 'PRs sit idle waiting for a reviewer',
        signal:
          'Pickup time trends up while merge volume is unchanged — add reviewers or a pickup SLA.',
      },
      {
        scenario: 'Time-zone or on-call gaps',
        signal: 'Recurring weekly bumps that line up with a thin reviewer roster.',
      },
    ],
  },
  REWORK_RATE: {
    howToRead:
      'The share of non-merge commits that rewrite lines changed within the previous 21 days — a proxy for churn and unstable work. Plotted weekly; lower is better with benchmark bands shown.',
    whatToLookFor: [
      'A high or rising rate — recent work is being redone rather than new value shipped.',
      'Sustained periods that slip below the High band into Medium or Low.',
      'Rework spikes that follow rushed releases.',
    ],
    useCases: [
      {
        scenario: 'Unclear requirements are causing thrash',
        signal:
          'Rework slips into the Medium/Low band and stays there while feature delivery slows.',
      },
      {
        scenario: 'A fragile area of the codebase',
        signal: 'Rework spikes repeatedly right after changes to the same module.',
      },
    ],
  },
  BUG_RATE: {
    howToRead:
      'Weekly counts of newly opened bug issues (rose) against all other issue types (grey). Read the ratio, not just the height — a tall rose bar next to a short grey one means quality problems are crowding out feature work.',
    whatToLookFor: [
      'Weeks where bugs approach or exceed other work.',
      'A rising bug trend across several weeks.',
      'Bug spikes right after a release.',
    ],
    useCases: [
      {
        scenario: 'A release shipped with quality debt',
        signal: 'Bugs jump the week after a launch and stay elevated.',
      },
      {
        scenario: 'The team is firefighting instead of building',
        signal: 'Bug bars consistently rival the other bars week over week.',
      },
    ],
  },
  TICKET_COVERAGE_RATE: {
    howToRead:
      'The percentage of merged PRs that link to at least one tracking ticket, with an 8-week sparkline and its benchmark tier. Higher is better — it measures traceability between code and planned work.',
    whatToLookFor: [
      'A number below the High benchmark band — a lot of work is shipping untracked.',
      'The sparkline direction; a downward drift means process discipline is slipping.',
      'Sudden drops that coincide with crunch periods.',
    ],
    useCases: [
      {
        scenario: 'An audit needs code-to-work traceability',
        signal: 'Coverage sits below the Elite band — unlinked PRs are your audit gaps.',
      },
      {
        scenario: 'Scope creep is hiding in quick fixes',
        signal: 'Coverage falls while PR volume rises — untracked work is growing.',
      },
    ],
  },
  INVESTMENT_ALLOCATION: {
    howToRead:
      'A donut of where completed effort went in the window, by count of issues closed: new features (green), bug fixes (rose), tech debt (amber), keep-the-lights-on maintenance (slate), and uncategorised (violet). It answers "what did we actually spend the last quarter on?"',
    whatToLookFor: [
      'The feature slice versus everything else — your ratio of new value to upkeep.',
      'An oversized bug or maintenance slice, signalling reactive work.',
      'A large uncategorised slice, meaning the mix can’t be trusted until issues are typed.',
    ],
    useCases: [
      {
        scenario: 'Justifying a tech-debt investment to the board',
        signal:
          'The tech-debt slice is tiny while bug and maintenance dominate — you are paying interest, not principal.',
      },
      {
        scenario: 'The feature roadmap keeps slipping',
        signal: 'The feature slice is well under half — upkeep is quietly eating capacity.',
      },
    ],
  },
  VELOCITY_WITH_CONFIDENCE: {
    howToRead:
      'Completed work per sprint (Jira/ADO) with a shaded ±1 standard-deviation band around it. The band’s width is the real signal: a narrow band means predictable delivery, a wide one means volatile output you can’t plan against.',
    whatToLookFor: [
      'Band width — narrowing is good (more predictable), widening is a planning risk.',
      'The centre-line trend for genuine speed-up or slow-down.',
      'Sprints that fall outside the band — investigate what made them abnormal.',
    ],
    useCases: [
      {
        scenario: 'Commitments keep missing',
        signal:
          'A wide confidence band — plan to the lower edge, not the average, until it narrows.',
      },
      {
        scenario: 'The team has stabilised after a reorg',
        signal: 'The band tightens over several sprints even if the average is flat.',
      },
    ],
  },
  PR_SIZE_DISTRIBUTION: {
    howToRead:
      'A histogram of merged PRs bucketed by size (XS to XL by lines changed), coloured by benchmark tier. Smaller is better — small PRs review faster, merge sooner, and break less. A healthy team’s mass sits in the XS/S buckets.',
    whatToLookFor: [
      'Weight in the L/XL buckets — big batches that slow review and raise risk.',
      'Whether the distribution is shifting toward larger sizes over time.',
      'A bimodal shape (many tiny plus a few huge) hiding risky mega-PRs.',
    ],
    useCases: [
      {
        scenario: 'Reviews are a bottleneck',
        signal: 'A fat L/XL tail — large PRs are what clog the review queue.',
      },
      {
        scenario: 'A push for smaller PRs is working',
        signal: 'Mass migrates left into the XS/S buckets across successive windows.',
      },
    ],
  },
  WIP_COUNT: {
    howToRead:
      'The current number of issues in progress, with an 8-week sparkline of how that count has moved. Lower and steady is generally healthier — high WIP means work is started but not finished, which lengthens cycle time.',
    whatToLookFor: [
      'A rising sparkline — the team is taking on more than it finishes.',
      'A WIP number well above team size, implying heavy context-switching.',
      'WIP that climbs while throughput stays flat.',
    ],
    useCases: [
      {
        scenario: 'Cycle time is creeping up',
        signal:
          'WIP has been trending up on the sparkline — too many parallel items, not slow individuals.',
      },
      {
        scenario: 'Too much started, little finished',
        signal: 'A high current count alongside a flat or falling completion trend elsewhere.',
      },
    ],
  },

  // ── Speed / developer activity ───────────────────────────────
  VELOCITY_LEADERBOARD: {
    howToRead:
      'Engineers ranked by average days from a project’s first "In Progress" move to its "Done" move, using completions in the selected time range. Lower average days ranks higher (#1 is fastest).',
    whatToLookFor: [
      'Wide gaps between #1 and the bottom of the list — inconsistent throughput across the team.',
      'A very fast average built on just a handful of completions — the ranking may not be statistically meaningful yet.',
      'The same names sliding down the ranking release after release.',
    ],
    useCases: [
      {
        scenario: 'One engineer looks like a 10x performer',
        signal:
          'A very fast average paired with very few completions — check the volume before crediting the speed.',
      },
      {
        scenario: 'Spotting who needs support before a 1:1',
        signal:
          'An engineer consistently ranked near the bottom across several review periods, not just one.',
      },
    ],
  },
  CH_VELOCITY: {
    howToRead:
      'A bar per week of how many GitHub PRs merged, counted directly from merge events in the connected window. Taller bars mean more shipped work; there is no benchmark tier on this widget, so read it by trend rather than an absolute target.',
    whatToLookFor: [
      'A sustained drop in bar height across several weeks — throughput is slowing.',
      'One-week spikes or dips that line up with holidays, releases, or headcount changes.',
      'The Total and Peak figures below the chart for a quick sense of scale.',
    ],
    useCases: [
      {
        scenario: 'Checking whether output held up after a team change',
        signal:
          'Bar heights before and after the change stay roughly flat rather than stepping down.',
      },
      {
        scenario: 'Confirming a slow quarter was real, not a fluke',
        signal: 'Multiple consecutive short bars, not just one low week.',
      },
    ],
  },
  CH_CYCLE_TIME_TREND: {
    howToRead:
      'The median (p50) hours it took merged GitHub PRs to go from open to merged, plotted weekly as a line. Lower is better; there are no benchmark bands here, so judge it by the line’s own trend.',
    whatToLookFor: [
      'A line climbing over several consecutive weeks — PRs are taking longer end to end.',
      'Single-week spikes that may just be one or two outsized PRs rather than a systemic shift.',
      'The Latest-vs-Peak readout for how far off the recent week is from the worst week shown.',
    ],
    useCases: [
      {
        scenario: 'Did a recent process change actually speed things up?',
        signal: 'The line steps down and stays down in the weeks following the change.',
      },
      {
        scenario: 'Cycle time is drifting but no one has noticed yet',
        signal: 'A slow, steady upward slope over the full window rather than a single bad week.',
      },
    ],
  },
  MERGE_FREQUENCY_PER_DEV: {
    howToRead:
      'One row per developer: total PRs merged in the window, average merges per week (colour-coded by benchmark tier), and a sparkline of weekly merge counts. Higher merge frequency is better. Click a row to drill into that developer’s PRs.',
    whatToLookFor: [
      'Rows sitting at the Medium or Low tier — those developers are shipping less frequently than the rest.',
      'A sparkline trending down even while the average-per-week figure still looks fine.',
      'One or two names dominating total PRs while the rest of the table is thin — an over-reliance risk.',
    ],
    useCases: [
      {
        scenario: 'A developer seems to have gone quiet',
        signal:
          'Their sparkline flattens toward zero over the recent weeks while others stay steady.',
      },
      {
        scenario: 'Bus-factor risk on a team',
        signal:
          'Merge volume concentrated in one or two rows, with the rest of the table well below the Elite tier.',
      },
    ],
  },
  COMMITS_PER_DEV: {
    howToRead:
      'One row per developer, unified across GitHub, GitLab and ADO: commit count, lines added/removed, the percentage of their commits flagged as AI-assisted, and a weekly commit-count sparkline. There are no benchmark tiers — read it relative to the rest of the table.',
    whatToLookFor: [
      'A high commit count paired with very few lines changed — many small or trivial commits rather than substantive change.',
      'An AI-assist % that is much higher or lower than the rest of the team for the same role.',
      'A sparkline trending toward zero — that developer is going quiet even if their totals still look reasonable.',
    ],
    useCases: [
      {
        scenario: 'Sanity-checking a commit-count-only view of productivity',
        signal:
          'Cross-reference commits against the lines-changed column — a top-commit-count row with minimal lines changed is not necessarily the most productive.',
      },
      {
        scenario: 'Gauging real AI-tool adoption per person',
        signal:
          'AI-assist % varies widely row to row rather than clustering — adoption is uneven across the team, not org-wide yet.',
      },
    ],
  },
  REVIEWER_PARTICIPATION: {
    howToRead:
      'One row per human reviewer (bots excluded) across GitHub and Azure DevOps: how many reviews they gave and how many of those were approvals in the window. There is no benchmark tier — compare rows against each other.',
    whatToLookFor: [
      'A handful of reviewers carrying most of the review load while others show near-zero reviews.',
      'An approvals count that nearly equals their reviews given — a possible rubber-stamp reviewer worth a closer look.',
      'A reviewer roster that is thin relative to the team size the other widgets imply.',
    ],
    useCases: [
      {
        scenario: 'Review load is unevenly distributed and burning out one or two people',
        signal:
          'One or two rows with reviews given far above the rest of the table, week after week.',
      },
      {
        scenario: 'Checking whether reviews are substantive or rubber-stamped',
        signal:
          'Approvals sitting almost exactly at reviews given for a reviewer, with little gap for requested-changes rounds.',
      },
    ],
  },

  // ── Flow ─────────────────────────────────────────────────────
  COMPLETION_RATE: {
    howToRead:
      'The percentage of the board’s current projects that moved to Done within the selected window — the completed count comes from status-change history, divided by today’s total project count on the board. Higher is better, but the total is the board’s size right now, not its size when the window started.',
    whatToLookFor: [
      'A rate stuck in single digits regardless of window length — a lot of the board is not finishing.',
      'The rate jumping a lot between the 7/14/30-day options — completions are bursty rather than steady.',
      'A rate that looks high mainly because the total project count is small — check the total alongside the percentage.',
    ],
    useCases: [
      {
        scenario: 'The board looks full but nothing seems to ship',
        signal: 'The rate stays low across every window option, not just the shortest one.',
      },
      {
        scenario: 'Confirming a sprint push actually landed',
        signal:
          'Switching from the 7-day to the 30-day window shows the rate jump — completions are concentrated in the recent stretch, not spread evenly.',
      },
    ],
  },
  CH_COMPLETION_TREND: {
    howToRead:
      'A daily line of how many Jira issues transitioned into a Done-named status, built from the raw transition history in ClickHouse over the selected day range. More, steadier completions are better; the footer calls out the total and the single peak day.',
    whatToLookFor: [
      'Days with zero or near-zero completions breaking up an otherwise steady line.',
      'A peak day that lines up with (or doesn’t) a known release or sprint-close date.',
      'The overall slope across the range — climbing, flat, or fading completion volume.',
    ],
    useCases: [
      {
        scenario: 'Verifying a release actually shipped work',
        signal: 'A visible spike day lands on or right after the release date.',
      },
      {
        scenario: 'Spotting an unplanned work stoppage',
        signal: 'A run of flat, near-zero days appears with no corresponding calendar event.',
      },
    ],
  },
  ISSUES_OPENED_VS_CLOSED: {
    howToRead:
      'Weekly grouped bars of issues created (grey) versus issues closed (green) across every connected issue source. Closed catching up with or overtaking opened each week is the healthy pattern — the team is clearing at least as fast as new work arrives.',
    whatToLookFor: [
      'Opened running above closed for several consecutive weeks — the backlog is growing.',
      'Weeks where the green closed bar clearly exceeds the grey opened bar — active drawdown.',
      'A gap between the two bars that keeps widening week over week rather than staying flat.',
    ],
    useCases: [
      {
        scenario: 'The backlog is quietly ballooning',
        signal: 'Opened outpaces closed for four or more consecutive weeks.',
      },
      {
        scenario: 'Checking whether a declared cleanup sprint worked',
        signal: 'Closed spikes above opened in the weeks right after the push was announced.',
      },
    ],
  },
  FLOW_THROUGHPUT_CYCLE: {
    howToRead:
      'Bars are the count of Jira/ADO items delivered each week; the line is the median created-to-done cycle time (in days) for that same week’s deliveries. Items that took longer than the configured max-age are dropped from the median and instead flag that week with a hollow marker, so one bulk historical close can’t distort the line. Rising bars with a falling line is the ideal combination.',
    whatToLookFor: [
      'Bars falling while the cycle-time line climbs at the same time — throughput and speed both degrading together.',
      'A hollow (flagged) marker on the line — that week’s median excluded outlier items; treat the number as partial.',
      'Bars rising alongside a rising line — more is being pushed through, but each item is taking longer, which rarely holds up.',
    ],
    useCases: [
      {
        scenario: 'Confirming a process change actually sped delivery up',
        signal: 'Bars hold steady or rise while the cycle-time line steps down and stays down.',
      },
      {
        scenario: 'A suspiciously good cycle-time week turns out to be an import artifact',
        signal:
          'That week shows a flagged (hollow) marker — a bulk close of old items was excluded from the median, not a real speed-up.',
      },
    ],
  },
  DELIVERY_TREND_ANNOTATED: {
    howToRead:
      'A weekly line of items delivered from Jira/ADO, with shaded bands marking calendar events (freezes, migrations, holidays — board-specific or company-wide) and the single highest-delivered week auto-marked as the peak. Read dips against the shaded bands before treating them as a real problem.',
    whatToLookFor: [
      'A dip that falls inside a shaded band — explained by the calendar event, not a team slowdown.',
      'A dip with no shaded band anywhere near it — that one is a genuine drop worth investigating.',
      'Where the auto-marked peak sits relative to any shaded band.',
    ],
    useCases: [
      {
        scenario: 'Explaining a low-delivery week to leadership',
        signal:
          'The low week sits inside a shaded freeze/migration band — the calendar explains it, not performance.',
      },
      {
        scenario: 'Understanding what a great week looked like',
        signal:
          'The peak marker lands on a week with no shaded overlay at all — worth digging into what the team did differently.',
      },
    ],
  },
  CH_BACKLOG_AGE: {
    howToRead:
      'A horizontal histogram of currently-open Jira issues bucketed by age since creation (0–7d, 7–30d, 30–90d, 90d+), computed fresh each time — there is no date-range filter, so it always reflects today’s backlog. A healthy backlog has most of its mass in the youngest buckets.',
    whatToLookFor: [
      'A large or growing 90d+ bucket — issues that have sat untouched for three months or more.',
      'Weight in 30–90d shifting the overall shape older over successive checks.',
      'A thin 0–7d bucket next to a fat older tail — new intake is small relative to what is already stuck.',
    ],
    useCases: [
      {
        scenario: 'Backlog grooming has been neglected',
        signal: 'The 90d+ bucket is the largest bar, or close to it, in the distribution.',
      },
      {
        scenario: 'Deciding whether to run a backlog-cleanup pass',
        signal:
          'Comparing the chart week over week shows the older buckets growing rather than draining.',
      },
    ],
  },

  // ── AI adoption & review quality ─────────────────────────────
  AI_ASSISTED_PR_PCT: {
    howToRead:
      'The share of merged PRs carrying an AI-assist marker (commit trailer or PR marker), aggregated across the whole window and weighted by count so a slow current week can’t skew it, with a weekly sparkline underneath.',
    whatToLookFor: [
      'The detector is marker-based — a low or 0% reading means no markers were found, not proof AI wasn’t used.',
      'A sparkline that keeps climbing week over week as adoption spreads.',
      'A sudden flat line after a tooling change — check whether the new tool still leaves a marker.',
    ],
    useCases: [
      {
        scenario: 'Leadership wants to know how far AI-assisted coding has spread',
        signal: 'The headline % rises release over release as more of the team opts in.',
      },
      {
        scenario: 'A new AI tool was rolled out but adoption looks flat',
        signal:
          'Check whether the tool leaves a commit trailer or PR marker at all — absence here can just mean undetected use.',
      },
    ],
  },
  REVIEW_MIX: {
    howToRead:
      'Splits each merged PR’s first non-comment review into bot or human by reviewer login, then shows the bot share of those first reviews, the bot share of comment-only reviews, and the median hours-to-first-review for each reviewer type, with a weekly bot-share trend line. GitHub only.',
    whatToLookFor: [
      'A bot pickup time much faster than the human pickup — bots absorb the easy first pass while humans handle the substance.',
      'A rising bot review-share trend, meaning more of your first-look coverage is automated.',
      'Bot comment share far above bot review share — bots that mostly leave comments rather than approvals/changes-requested.',
    ],
    useCases: [
      {
        scenario: 'Deciding whether a bot reviewer is pulling its weight',
        signal:
          'Bot pickup is near-instant and bot review share is meaningful — it is genuinely absorbing first-pass load.',
      },
      {
        scenario: 'Human reviewers still bottleneck merges despite a bot in the pipeline',
        signal: 'Human pickup time stays high even as the bot share of first reviews climbs.',
      },
    ],
  },
  BOT_VS_HUMAN: {
    howToRead:
      'The share of non-merge commits carrying an AI-assist trailer (e.g. a Claude Code co-author) versus human-only commits, landed in the window across GitHub/GitLab/ADO, with a weekly line for each. Commits, not reviews, because that is the unit of work actually shipped.',
    whatToLookFor: [
      'The trailer detector is a floor, not a ceiling — a low bot share can mean low adoption or just untagged AI use.',
      'A bot line that climbs relative to the human line over successive weeks.',
      'A sudden divergence between the two lines that lines up with a tooling rollout or policy change.',
    ],
    useCases: [
      {
        scenario: 'Tracking rollout of an AI coding assistant across the team',
        signal:
          'The bot commit line trends up week over week while human commits stay flat or dip.',
      },
      {
        scenario: 'Sanity-checking a suspiciously low AI-assist number',
        signal:
          'Confirm the tool in use actually stamps a Co-Authored-By trailer — if not, this widget will undercount it.',
      },
    ],
  },
  AI_ADOPTION: {
    howToRead:
      'A sortable table of AI-assisted PR % and AI-assisted commit % per period (week or month), each computed independently from its own trailer/marker detection and joined so a period with only PRs or only commits still appears with the other column zeroed.',
    whatToLookFor: [
      'PR % and commit % diverging — AI use showing up in one activity type but not the other.',
      'Rows with a low total (PRs or commits) where the % is noisy and shouldn’t be over-read.',
      'A steady upward trend across periods versus a one-off spike tied to a single contributor.',
    ],
    useCases: [
      {
        scenario: 'Reporting AI-assist adoption trend to leadership month over month',
        signal: 'Both AI PR % and AI commit % climb together across consecutive periods.',
      },
      {
        scenario: 'One metric shows adoption but the other doesn’t',
        signal:
          'AI commit % is high while AI PR % stays low (or vice versa) — check whether trailers are being stripped somewhere in one of the two paths.',
      },
    ],
  },
  REVIEW_QUALITY_INDEX: {
    howToRead:
      'A five-row scorecard over merged PRs/MRs in the window: % with a peer approval (someone other than the author), the median hours a PR stayed open, % merged in under 10 minutes (instant merges — a red flag, not a green one), % that got a written comment, and % linking a ticket. Higher is better on every row except median-open and instant-merge.',
    whatToLookFor: [
      'Low peer-approval coverage — merges are happening without a genuine second set of eyes.',
      'A non-trivial instant-merge % — PRs merged in under 10 minutes are usually rubber-stamped, not reviewed.',
      'Comment % far below coverage % — approvals are being given silently, with no written feedback.',
    ],
    useCases: [
      {
        scenario: 'Auditing whether code review is real or theatrical',
        signal:
          'Coverage looks fine but comment % is low and instant-merge % is high — reviews are being rubber-stamped.',
      },
      {
        scenario: 'Justifying a review-process tightening to engineering leadership',
        signal: 'Ticket-linked % and comment % both sit low alongside a high instant-merge rate.',
      },
    ],
  },
  REVIEW_QUALITY_TREND: {
    howToRead:
      'Two lines over time, bucketed weekly or monthly: peer-approval coverage % and comment % of merged PRs/MRs (GitHub, ADO, GitLab), using the same genuine-peer-review logic as the Review Quality Index — approvals or comments from someone other than the author.',
    whatToLookFor: [
      'Both lines drifting down together — review rigor is eroding across the board, not just one dimension.',
      'Coverage staying flat while comment % falls — approvals are still happening but with less scrutiny.',
      'A step change that lines up with a headcount or process shift.',
    ],
    useCases: [
      {
        scenario: 'Checking whether a new review policy actually stuck',
        signal:
          'Coverage % steps up and holds after the policy change, rather than reverting within a few weeks.',
      },
      {
        scenario: 'Review quality quietly degrading under delivery pressure',
        signal:
          'Comment % trends down over several consecutive periods while coverage % stays nominally fine.',
      },
    ],
  },

  // ── Planning ─────────────────────────────────────────────────
  ITERATION_PLANNING_ACCURACY: {
    howToRead:
      'One bar per closed Jira sprint or ADO iteration, showing the % of committed issues that finished Done/Closed/Resolved by the iteration’s end, plotted against a target line. Higher is better — it measures whether sprint commitments are realistic, not raw output.',
    whatToLookFor: [
      'Bars sitting well below the target line for several iterations in a row — commitments are being over-planned.',
      'A single low iteration next to otherwise healthy ones — check what changed that sprint (scope added mid-flight, a blocker).',
      'Accuracy trending down over time even while team size holds steady.',
    ],
    useCases: [
      {
        scenario: 'Stakeholders have stopped trusting sprint plans because delivery keeps slipping',
        signal:
          'Several consecutive iterations sit below the target line — the team is over-committing at planning, not under-delivering at execution.',
      },
      {
        scenario:
          'A recent process change (smaller sprints, tighter refinement) is being evaluated',
        signal:
          'Accuracy climbs and stays above the target line in the iterations after the change.',
      },
    ],
  },
  INITIATIVE_RISK_RADAR: {
    howToRead:
      'A list of open epics, milestones, and board initiatives that carry a due date, each badged on-track, at-risk, or overdue based on days remaining against the widget’s configured horizon. It surfaces what needs attention now, not just what has already slipped.',
    whatToLookFor: [
      'Any item badged overdue — it has already missed its date and needs an explicit call on scope or timeline.',
      'A cluster of at-risk items landing in the same window — a capacity crunch is coming.',
      'An initiative you know is late that never appears here — it likely has no due date set, so this radar can’t track it yet.',
    ],
    useCases: [
      {
        scenario: 'Leadership asks what is slipping this quarter',
        signal:
          'Multiple items badged at-risk or overdue cluster around the same due window — that is the answer.',
      },
      {
        scenario: 'A due date got quietly pushed on a board row',
        signal:
          'The item’s badge flips from at-risk or overdue back to on-track right after the Due date edit.',
      },
    ],
  },
  PERIOD_COMPARISON: {
    howToRead:
      'A table comparing five delivery and quality KPIs — cycle time, deploy frequency, change-failure rate, time-to-restore, and throughput — between two adjacent windows (by default the last 90 days versus the 90 before), each row carrying a direction-aware Improved/Regressed/Flat verdict and % delta. Expanding a row shows a monthly sparkline graded Improving/Regressing/Flat/Stalling/Recovering.',
    whatToLookFor: [
      'Rows that verdict Regressed on the metrics that matter most to your roadmap risk, especially cycle time and change-failure rate.',
      'A row that verdicts Improved on the headline delta but grades Regressing or Stalling on the drill-down — the recent uptick may not be durable.',
      'N/A cells — that KPI has no connected source for one or both windows, so treat the row as inconclusive, not zero.',
    ],
    useCases: [
      {
        scenario: 'The team wants proof a process change actually helped',
        signal:
          'Cycle time and throughput both verdict Improved with a positive delta in the window after the change.',
      },
      {
        scenario: 'A quarterly review needs a one-slide "are we getting better" answer',
        signal:
          'Count how many of the five rows verdict Improved versus Regressed — that ratio is the headline.',
      },
    ],
  },

  // ── Multi-board comparison (Comparison view only) ────────────
  COMPARE_REVIEW_QUALITY: {
    howToRead:
      'One peer-approval-coverage % line per board, plus a board-as-columns scorecard covering coverage, median PR-open time, comment rate, ticket-linking rate, and merged-PR volume. Higher is better on every row except PR-open time; the merged-PR volume row is greyed whenever the compared boards mix Jira/ADO/GitHub/GitLab, since raw counts aren’t comparable across providers.',
    whatToLookFor: [
      'Which board’s coverage line sits lowest — that team merges without peer approval more often.',
      'A greyed merged-PR volume cell — the board set mixes providers, so don’t compare that number directly.',
      'A board with high coverage but a low comment rate — approvals may be rubber-stamped rather than substantive.',
    ],
    useCases: [
      {
        scenario: 'Deciding which team’s review process to roll out company-wide',
        signal:
          'One board’s coverage and comment-rate lines both lead the pack consistently, not just in one week.',
      },
      {
        scenario: 'A team’s review discipline looks like it is slipping relative to peers',
        signal:
          'Its coverage line diverges downward from the others over several consecutive weeks.',
      },
    ],
  },
  COMPARE_FLOW: {
    howToRead:
      'One cycle-time line per board, plus a scorecard with each board’s median cycle time in days and total items delivered over the window. Lower cycle time is better; the delivered-volume row is greyed whenever the compared boards mix Jira/ADO, since issue counting differs by provider.',
    whatToLookFor: [
      'Which board’s cycle-time line sits highest — that team takes longest start-to-finish.',
      'A greyed delivered-volume cell — the board set mixes providers, so don’t read that number as a straight comparison.',
      'A board whose cycle-time line is climbing while the others hold flat — isolate what changed for that team.',
    ],
    useCases: [
      {
        scenario: 'Two teams claim similar velocity but one feels slower to stakeholders',
        signal:
          'Its cycle-time line sits well above the other board’s even though delivered volume looks similar.',
      },
      {
        scenario: 'Deciding where to invest in process improvement first',
        signal:
          'Rank boards by median cycle time in the scorecard — the worst outlier is the next target.',
      },
    ],
  },
  COMPARE_DELIVERY: {
    howToRead:
      'One delivered-items line per board over time, with a shared freeze/holiday/migration overlay drawn once across all lines so dips can be explained rather than misread, plus a scorecard totalling delivered items per board. Higher is better; the totals row is greyed whenever the compared boards mix Jira/ADO, since issue counting differs by provider.',
    whatToLookFor: [
      'A dip that lines up with a freeze or holiday marker on the shared overlay — that’s expected, not a delivery problem.',
      'A dip with no overlay marker nearby — that’s a real slowdown worth investigating.',
      'A greyed delivered-total cell — the board set mixes providers, so compare trend shapes rather than raw totals.',
    ],
    useCases: [
      {
        scenario: 'Explaining a quarter-end delivery dip to the board',
        signal:
          'The dip aligns with a freeze or holiday annotation shared across all boards’ lines.',
      },
      {
        scenario: 'One team’s delivery is falling behind its peers',
        signal: 'Its line diverges downward from the others outside of any shared freeze window.',
      },
    ],
  },
};
