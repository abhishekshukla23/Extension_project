import express from "express";
import { success, validate, z } from "zod";
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
const analysisSchema = z.object({
  verdict: z.enum([
    "supported",
    "contradicted",
    "mixed",
    "insufficient_evidence"
  ]),
  explanation: z.string().min(1),
  source_indices: z.array(z.number().int().positive()),
  needs_more_research: z.boolean(),
next_search_query: z.string().nullable()
});
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
      format:"json",
      think:false,
      options:{
        num_predict:500
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

async function extractClaims(segments) {
   const prompt = `
You are a factual claim extraction assistant.

Analyze the following YouTube transcript segments.

Extract every distinct, specific, verifiable factual claim
from the transcript. Do not skip factual statements.
Do not combine separate factual statements into one claim.
For each claim, provide:
- claim: A clear factual statement.
- quote: The exact supporting text from the transcript.
- timestamp: The start time of the supporting segment.

Do not invent information.
Do not extract opinions or vague statements.


Return ONLY valid JSON in this format:

{
  "claims": [
    {
      "claim": "A factual statement",
      "quote": "Exact transcript quote",
      "timestamp": 12.5
    }
  ]
}

Transcript:
${JSON.stringify(segments)}
`;

const response=await askOllama(prompt);

const parsed =JSON.parse(response);

return claimsSchema.parse(parsed).claims;

}
 

async function searchEvidence(claim) {
  const results=await tvly.search(
    claim,
    {
      searchDepth:"advanced",
      maxResults:5
    }
  )
  
  return results.results;
}



async function analyzeEvidence(claim,result) {
   const evidence=result.map((result,index)=>({
    source:index+1,
    title:result.title,
    url:result.url,
    content:result.content
   }));

   const prompt = `
You are a strict fact-checking assistant.

Evaluate the EXACT claim using the retrieved evidence.

CLAIM:
${claim}

EVIDENCE:
${JSON.stringify(evidence, null, 2)}

RULES:
1. Evaluate the exact claim. Never change its meaning.
2. Compare numerical values carefully.
3. A different numerical value contradicts the claim
   when both refer to the same measurement.
4. Never invent explanations to make a claim true.
5. If evidence directly disagrees, return contradicted.
6. Decide whether the available evidence is sufficient
   to reach a reliable verdict.
7. If evidence is insufficient, set needs_more_research
   to true and provide a specific next_search_query.
8. If evidence is sufficient, set needs_more_research
   to false and next_search_query to null.

Return ONLY valid JSON:

{
  "verdict": "supported | contradicted | mixed | insufficient_evidence",
  "explanation": "Brief explanation based on evidence",
  "source_indices": [1, 2],
  "needs_more_research": false,
  "next_search_query": null
}

Do not generate URLs.
Do not use Markdown.
Do not add text outside JSON.
`;

const response=await askOllama(prompt);
console.log("Qwen raw response:", response);
const parsed=JSON.parse(response);
const validated = analysisSchema.parse(parsed);
if (validated.source_indices.some(index => index > result.length)) {
  throw new Error("Qwen returned an invalid source index");
}
const selectedSources=validated.source_indices
.map(index=>result[index-1])
.filter(Boolean)
.map(source=>({
  title:source.title,
  url:source.url,
  content:source.content
})
)

return {
  verdict: validated.verdict,
  explanation: validated.explanation,
  sources: selectedSources,
  needs_more_research: validated.needs_more_research,
  next_search_query: validated.next_search_query
};




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


// app.post("/test-search", async (req, res) => {
//   try {
//     const { claim } = req.body;

//     if (!claim) {
//       return res.status(400).json({ error: "Claim is required" });
//     }

//     const results = await searchEvidence(claim);

//     res.status(200).json({
//       success: true,
//       results
//     });
//   } catch (error) {
//     console.error("Search error:", error);
//     res.status(500).json({ error: error.message });
//   }
// });

async function factCheckWithResearch(claim) {
  let evidence = await searchEvidence(claim);

  let analysis = await analyzeEvidence(claim, evidence);

  return analysis;
}

app.post('/fact-check',async (req,res)=>{
  try {
    const validation=factCheckSchema.safeParse(req.body)

    if(!validation.success){
      return res.status(400).json({
        success:FontFaceSetLoadEvent,
        message:"invalid claim data",
        errors:validation.error.issue
      })
    }

    const {claim,quote,timestamp}=validation.data;

    const analysis=await factCheckWithResearch(claim)

    return res.status(200)
    .json({
      success:true,
      claim,
      quote,
      timestamp,
      analysis
    })
    
  } catch (error) {
    console.error("Fact-check error",error)
    return res.status(500)
    .json({
      success:false,
      message:"Unable to fact-check claim"
    })
  }
})



app.listen(3000, () => {
  console.log("The server is running on port 3000");
});
