import express from "express";
import { z } from "zod";
import { tavily } from "@tavily/core";
import { fetchTranscript } from "youtube-transcript";
import "dotenv/config";

const app = express();
app.use(express.json({ limit: "5mb" }));

const tvly=tavily({
   apiKey:process.env.TAVILY_API_KEY
})

// Validate claims returned by Gemini
const claimsSchema = z.object({
  claims: z.array(
    z.object({
      claim: z.string().trim().min(1),
      quote: z.string().trim().min(1),
      timestamp: z.number().finite().nonnegative()
    })
  )
});

// Validate incoming transcript segments
const segmentsSchema = z.array(
  z.object({
    text: z.string().trim().min(1),
    start: z.number().finite().nonnegative()
  })
).min(1).max(100000);

const factCheckSchema=z.object(
  {
    claim:z.string().trim().min(1),
    quote:z.string().optional(),
    timestamp:z.number().finite().nonnegative().optional()
  }
)

async function askOllama(prompt) {
  const start=Date.now()
  const response = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
     model: "qwen2.5:3b",
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      think:false,
      options:{
        num_predict:300
      },
      stream: false
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status}`);
  }

  const data = await response.json();
  
  console.log("Complete Ollama response:", JSON.stringify(data, null, 2));

  console.log("Total Ollama time:", (Date.now() - start) / 1000, "seconds");
  console.log("Prompt tokens:", data.prompt_eval_count);
  console.log("Generated tokens:", data.eval_count);
  console.log("Generation duration:", data.eval_duration / 1e9, "seconds");
  return data.message.content;
}
 














// Split transcript into 5-minute windows with 30-second overlap
function chunkTranscript(segments) {
  const sorted = [...segments].sort((a, b) => a.start - b.start);

  const windowSeconds = 300;
  const stepSeconds = 270;
  const maxStart = sorted[sorted.length - 1].start;
  const chunks = [];

  for (let start = 0; start <= maxStart; start += stepSeconds) {
    const chunk = sorted.filter(segment =>
      segment.start >= start &&
      segment.start < start + windowSeconds
    );

    if (chunk.length > 0) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

// Process chunks with limited concurrency
async function processChunks(chunks, concurrency = 3) {
  const results = new Array(chunks.length);
  const failedChunks = [];
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;

      if (index >= chunks.length) {
        return;
      }

      try {
        results[index] = await extractClaims(chunks[index]);
      } catch (error) {
        console.error(`Chunk ${index} failed:`, error.message);

        failedChunks.push(index);
        results[index] = [];
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, chunks.length) },
      () => worker()
    )
  );

  return {
    claims: results.flat(),
    failedChunks: failedChunks.length
  };
}

// Remove duplicate claims
function deduplicateClaims(claims) {
  const seen = new Set();

  return claims.filter(item => {
    const key = item.claim
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/\s+/g, " ")
      .trim();

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

// Existing transcript endpoint
app.post("/transcript", async (req, res) => {
  try {
    const { videoId } = req.body;

    if (!videoId) {
      return res.status(400).json({
        success: false,
        message: "Video ID not found"
      });
    }

    const transcript = await fetchTranscript(videoId);

    return res.status(200).json({
      success: true,
      transcript
    });
  } catch (error) {
    console.error("Transcript retrieval failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch transcript. Captions may be unavailable."
    });
  }
});

// New claims endpoint
app.post("/claims", async (req, res) => {
  try {
    const validation = segmentsSchema.safeParse(
      req.body?.segments
    );

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid transcript segments",
        errors: validation.error.issues
      });
    }

    const segments = validation.data;
    const chunks = chunkTranscript(segments);

    const result = await processChunks(chunks);

    const claims = deduplicateClaims(result.claims)
      .sort((a, b) => a.timestamp - b.timestamp);

    return res.status(200).json({
      success: true,
      claims,
      failedChunks: result.failedChunks,
      partial: result.failedChunks > 0
    });

  } catch (error) {
    console.error("Claim extraction failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to extract claims"
    });
  }
});


app.post('/test-ollama',async(req,res)=>{
  try {
    const answer=await askOllama(req.body.prompt);
    res.status(200).json({
      success:true,
      answer
    })
  } catch (error) {
    console.error("ollama error:",error)

    res.status(500).json({
      success:false,
      message:"ollama req failed"
    })
  }
})





app.listen(3000, () => {
  console.log("The server is running on port 3000");
});
