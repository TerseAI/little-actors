import { useEffect, useState } from "react"
import type { FormEvent } from "react"

import type { ActorTypes } from "../generated/ChatRoom.actor.js"
import { ActorClient } from "../generated/index.js"

const room = ActorClient({ endpoint: "/api/rooms/lobby/socket" }).ChatRoom.get("lobby")
type RoomProps = { name: string }

export function Chat() {
    const [name, setName] = useState<string | null>(null)
    const [draft, setDraft] = useState("")

    useEffect(() => {
        fetch("/api/session")
            .then(response => response.json())
            .then(session => setName(session.name))
    }, [])

    async function join(event: FormEvent) {
        event.preventDefault()
        const response = await fetch("/api/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: draft })
        })
        if (response.ok) setName(draft.trim())
    }

    return (
        <main>
            <h1>The lobby</h1>
            {name ? (
                <Room name={name} />
            ) : (
                <form onSubmit={join}>
                    <label htmlFor="name">Name</label>
                    <input id="name" value={draft} onChange={event => setDraft(event.target.value)} maxLength={32} required />
                    <button disabled={!draft.trim()}>Join</button>
                </form>
            )}
        </main>
    )
}

function Room({ name }: RoomProps) {
    const [history, setHistory] = useState<ActorTypes["state"]["history"]>([])
    const [message, setMessage] = useState("")
    const [connected, setConnected] = useState(false)

    useEffect(() => {
        const unsubscribe = room.subscribe("history", setHistory)
        const offStatus = room.on("status", status => setConnected(status === "open"))
        room.connect().catch(console.error)
        return () => {
            unsubscribe()
            offStatus()
            room.close()
        }
    }, [])

    function send(event: FormEvent) {
        event.preventDefault()
        room.send({ type: "post", text: message.trim() })
        setMessage("")
    }

    return (
        <>
            <p>Chatting as {name}</p>
            <ol role="log" aria-label="Messages">
                {history.map((item, index) => (
                    <li key={index}>
                        <strong>{item.name}</strong>
                        <p>{item.text}</p>
                    </li>
                ))}
            </ol>
            <form onSubmit={send}>
                <label htmlFor="message">Message</label>
                <input id="message" value={message} onChange={event => setMessage(event.target.value)} maxLength={500} required />
                <button disabled={!connected || !message.trim()}>Send</button>
            </form>
        </>
    )
}
