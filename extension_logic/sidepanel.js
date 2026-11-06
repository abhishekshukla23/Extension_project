const videoElement=document.getElementById("id");
const transcriptElement=document.getElementById("transcript")


chrome.storage.session.get("Videos",result=>{
    videoElement.innerText=result.Videos || "No video selected"
})

chrome.runtime.onMessage.addListener(message=>{
    if(message.type==="show"){
        videoElement.innerText=message.videoId
    }
    if(message.type==="TRANSCRIPT_LOADED"){
        videoElement.innerText=message.videoId;
        transcriptElement.innerText=message.transcript.
        map(item=>item.text)
        .join(" ");
    }
    if(message.type==="TRANSCRIPT_ERROR"){
        transcriptElement.innerText=message.error;
    }
}) 