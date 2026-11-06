chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(message.type==="VIDEO_CHANGED"){
    const videoId=message.videoId;

    chrome.storage.session.set({Videos:videoId})

    fetch("http://localhost:3000/transcript",{
        method:"POST",
        headers:{
            "Content-type":"application/json"
        },
        body:JSON.stringify({videoId})
    })
    .then(response=>{
        if(!response.ok){
            throw new Error("failed to fetch the transcript")
        }
        return response.json();
    })
    .then(data=>{
        chrome.runtime.sendMessage({
            type:"TRANSCRIPT_LOADED",
            videoId,
            transcript:data.transcript
        })
    })
    .catch(error=>{
        console.error("transcript error: ",error)
        chrome.runtime.sendMessage({
            type:"TRANSCRIPT_ERROR",
            videoId,
            error:error.message
        })
    })
  }
})