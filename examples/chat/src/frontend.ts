import { createElement } from "react"
import { createRoot } from "react-dom/client"

import { Chat } from "./Chat.js"
import "./style.css"

createRoot(document.getElementById("root")!).render(createElement(Chat))
