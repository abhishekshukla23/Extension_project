import express from "express";
import {fetchTranscript} from 'youtube-transcript'
const app=express();


app.get('/',(req,res)=>{
    res.send("hello")
})

app.use(express.json())

