import { buildAnnualBenchmark } from "../src/anomalyBenchmark.js";

const artifact = await buildAnnualBenchmark({
  progress: (message) => console.log(`[anomaly:benchmark] ${message}`),
});

console.log(
  `[anomaly:benchmark] complete ${artifact.artifactChecksum ?? "checksum unavailable"}`,
);
