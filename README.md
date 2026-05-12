This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Summary of Benefits PDF Pipeline

The Summary of Benefits acquisition script looks up 2026 plans in Prisma for the current licensed states/counties represented in the database, filters to HealthSpring, UnitedHealthcare/UHC, Devoted Health, and Aetna Medicare, deduplicates by plan ID, plan year, and organization, and writes candidate PDF downloads to `sb-download-list.json`.

Run the pipeline in stages:

```bash
npm run acquire-sb-pdfs
npm run download-sb-pdfs
npm run discover-sb-pdfs -- ./summary-of-benefits
npx tsx scripts/extract-sb-benefits.ts --update-db --dry-run
```

`npm run acquire-sb-pdfs` can use `BING_SEARCH_API_KEY`, `AZURE_BING_SEARCH_API_KEY`, or `SERPAPI_API_KEY` when available. If web search is not available, paste manual results into `sb-search-results.json` or `sb-manual-sb-urls.json`; supported entries can be simple URL strings or objects with `url`, `title`, `snippet`, `sourceUrl`, `planId`, `planYear`, `organizationName`, and `planName`.

The script only writes high-confidence matches to `sb-download-list.json`; plans that still need review go to `sb-unresolved-plans.json` with generated search queries and the best low-confidence candidate, when one exists. Keep `extract-sb-benefits.ts` in `--dry-run` until the PDF matches and extracted benefits have been reviewed; CMS/PBP values should only be overwritten after high-confidence verification.
