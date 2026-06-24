# Architecture Decisions

This is a list of architecture decisions, alternatives for each and my reasoning.

## Split between Cloudflare and AWS

This app will use cloudflare workers for edge ingestion and coordination and AWS Fargate for video processing.

Alternatives:

- All cloudflare workers
    - Simpler to manage and deploy
    - Worker CPU usage limited for large files, no batching support
- All AWS Fargate
    - Edge on cloudflare used for coordination and Fargate for processing
    - Much more powerful processing

## Store data in S3 (AWS) and not R2 (Cloudflare)

S3 makes more sense than R2 because the object storage will require lots of data movement between chunked video files and processing tasks inside of Fargate. This will save latency and egress costs.

Thus, in the final design the only thing crossing the boundary between the cloud providers will be the upload of the video, completion pinging to the cloudflare workers, and the download of the processed video.

## Use Durable Objects for Coordination

Durable Objects are better here than a DB or some sort because they are single threaded. This means that it is the single point of truth for the state of each worker and coordination. This allows us to avoid race conditions and ensures that two workers don't notify the DB of completion at the same time.

## Chunk the video instead of processing the entire file at once

Parallel processing allows faster conversion of large files. This also allows this project to teach me distributed systems concepts and how to manage scale without a large user base.

Another benefit of this chunking is fault isolation. If one chunk fails it does not effect the others thus we can reattempt the failed chunk without affecting the rest of the video.
