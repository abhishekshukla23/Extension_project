let lastVideoId=null;

function detectVideo(){
    const url=new URL(window.location.href);
    if(url.pathname!='/watch'){
        return;
    }
   const videoId=url.searchParams.get("v");
   if(!videoId || videoId===lastVideoId){
    return;
   }
   lastVideoId=videoId;
   chrome.runtime.sendMessage({
    type:"VIDEO_CHANGED",
    videoId:videoId
   })
}

detectVideo();

document.addEventListener("yt-navigate-finish",detectVideo)