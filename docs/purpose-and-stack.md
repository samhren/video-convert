# Video Conversion Service

The goal of this application is to build on top of the Cloudflare knowledge I have of durable objects and workers with a conjunction on top of AWS serverless computer (Fargate) to create a video conversion service that teaches me System Design principles for distributed load testing, video processing pipelines, and distributed job queue management.

Tech Stack:

- Cloudflare
    - Workers (TypeScript)
    - Durable Objects (keeps track of if all N chunks are completed processing, trigger reassembly of the final video) (single-threaded thus allowing us to not have to worry about race conditions, data and decision stored in one place thus race free by design)
    - Workers Analytics Engine
- AWS
    - S3 for storing upload, chunking, and final output
    - SQS for job queue management
    - Fargate for ffmpeg autoscaling
- Web App
    - React, talks to **cloudflare workers only**
- Tooling
    - Wrangler
    - AWS CDK
    - Docker
    - Github Actions for CI/CD
    - Vitest
