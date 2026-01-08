// Основные переменные
let peer = null;
let currentConnection = null;
let username = "Гость";
let userId = null;
let currentChatId = null;
let db = null;

// Инициализация приложения
document.addEventListener('DOMContentLoaded', async () => {
    await initDatabase();
    await loadUserData();
    initPeerJS();
    setupEventListeners();
    showUsernameModal();
});

// Инициализация IndexedDB
async function initDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('P2PMessengerDB', 1);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            resolve();
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;

            // Хранилище для чатов
            if (!db.objectStoreNames.contains('chats')) {
                const chatsStore = db.createObjectStore('chats', { keyPath: 'id' });
                chatsStore.createIndex('lastActivity', 'lastActivity', { unique: false });
            }

            // Хранилище для сообщений
            if (!db.objectStoreNames.contains('messages')) {
                const messagesStore = db.createObjectStore('messages', { keyPath: 'id' });
                messagesStore.createIndex('chatId', 'chatId', { unique: false });
                messagesStore.createIndex('timestamp', 'timestamp', { unique: false });
            }

            // Хранилище для пользователя
            if (!db.objectStoreNames.contains('user')) {
                db.createObjectStore('user', { keyPath: 'id' });
            }
        };
    });
}

// Сохранение данных в IndexedDB
function saveToDB(storeName, data) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.put(data);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
    });
}

// Получение данных из IndexedDB
function getFromDB(storeName, key) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.get(key);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
    });
}

// Получение всех данных из хранилища
function getAllFromDB(storeName, indexName = null) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const request = indexName ? store.index(indexName).getAll() : store.getAll();

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
    });
}

// Загрузка данных пользователя
async function loadUserData() {
    const userData = await getFromDB('user', 'currentUser');
    if (userData) {
        username = userData.username;
        userId = userData.userId || generateUserId();
        document.getElementById('usernameDisplay').textContent = username;
        document.getElementById('userAvatar').textContent = username.charAt(0).toUpperCase();
        await loadChats();
    } else {
        userId = generateUserId();
    }
    document.getElementById('myId').textContent = userId;
}

// Инициализация PeerJS
function initPeerJS() {
    peer = new Peer(userId, {
        host: '0.peerjs.com',
        port: 443,
        path: '/',
        secure: true,
        debug: 2
    });

    peer.on('open', (id) => {
        console.log('My peer ID is: ' + id);
        userId = id;
        document.getElementById('myId').textContent = id;
        updateConnectionStatus('online');
    });

    peer.on('connection', (conn) => {
        console.log('Входящее соединение от:', conn.peer);
        handleIncomingConnection(conn);
    });

    peer.on('error', (err) => {
        console.error('PeerJS error:', err);
        updateConnectionStatus('error');
    });
}

// Обработка входящего соединения
async function handleIncomingConnection(conn) {
    conn.on('open', async () => {
        currentConnection = conn;
        const chatId = generateChatId(peer.id, conn.peer);

        // Проверяем, есть ли уже чат
        let chat = await getFromDB('chats', chatId);
        if (!chat) {
            chat = {
                id: chatId,
                peerId: conn.peer,
                title: `Чат с ${conn.peer.substring(0, 8)}`,
                avatar: conn.peer.charAt(0).toUpperCase(),
                lastActivity: Date.now(),
                unread: 0
            };
            await saveToDB('chats', chat);
            await loadChats();
        }

        // Открываем чат
        openChat(chatId);
        updateChatStatus('Подключен');
        enableMessageInput();

        // Отправляем приветствие
        sendSystemMessage(`Вы подключились к ${conn.peer}`);
    });

    conn.on('data', async (data) => {
        await handleIncomingMessage(data);
    });

    conn.on('close', () => {
        console.log('Соединение закрыто');
        if (currentChatId) {
            updateChatStatus('Соединение разорвано');
            disableMessageInput();
        }
    });

    conn.on('error', (err) => {
        console.error('Ошибка соединения:', err);
    });
}

// Обработка входящих сообщений
async function handleIncomingMessage(data) {
    if (data.type === 'message') {
        const message = {
            id: generateMessageId(),
            chatId: currentChatId,
            content: data.content,
            sender: data.sender,
            timestamp: Date.now(),
            isSystem: false
        };

        await saveToDB('messages', message);
        displayMessage(message);

        // Обновляем последнюю активность чата
        const chat = await getFromDB('chats', currentChatId);
        if (chat) {
            chat.lastActivity = Date.now();
            chat.lastMessage = data.content.substring(0, 30);
            await saveToDB('chats', chat);
            await loadChats();
        }
    } else if (data.type === 'typing') {
        updateChatStatus(`${data.sender} печатает...`);
    }
}

// Отправка сообщения
async function sendMessage(content) {
    if (!currentConnection || !currentConnection.open) {
        alert('Нет активного соединения!');
        return;
    }

    const message = {
        id: generateMessageId(),
        chatId: currentChatId,
        content: content,
        sender: username,
        timestamp: Date.now(),
        isSystem: false
    };

    // Сохраняем сообщение локально
    await saveToDB('messages', message);
    displayMessage(message);

    // Отправляем через PeerJS
    currentConnection.send({
        type: 'message',
        content: content,
        sender: username,
        timestamp: message.timestamp
    });

    // Обновляем чат
    const chat = await getFromDB('chats', currentChatId);
    if (chat) {
        chat.lastActivity = Date.now();
        chat.lastMessage = content.substring(0, 30);
        await saveToDB('chats', chat);
        await loadChats();
    }

    // Очищаем поле ввода
    document.getElementById('messageInput').value = '';
}

// Отправка системного сообщения
function sendSystemMessage(content) {
    const message = {
        id: generateMessageId(),
        chatId: currentChatId,
        content: content,
        sender: 'Система',
        timestamp: Date.now(),
        isSystem: true
    };

    saveToDB('messages', message);
    displayMessage(message);
}

// Отображение сообщения
function displayMessage(message) {
    const messagesContainer = document.getElementById('messagesContainer');
    const messageElement = document.createElement('div');
    messageElement.className = `message ${message.sender === username ? 'message-outgoing' : 'message-incoming'}`;

    const bubbleClass = message.isSystem ? 'system-bubble' : 'message-bubble';

    messageElement.innerHTML = `
        <div class="${bubbleClass}">${message.content}</div>
        <div class="message-time">${formatTime(message.timestamp)}</div>
    `;

    messagesContainer.appendChild(messageElement);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Загрузка чатов
async function loadChats() {
    const chats = await getAllFromDB('chats', 'lastActivity');
    const chatsList = document.getElementById('chatsList');
    chatsList.innerHTML = '';

    // Сортируем по последней активности
    chats.sort((a, b) => b.lastActivity - a.lastActivity);

    chats.forEach(chat => {
        const chatElement = document.createElement('div');
        chatElement.className = 'chat-item';
        chatElement.dataset.chatId = chat.id;

        chatElement.innerHTML = `
            <div class="chat-avatar">${chat.avatar}</div>
            <div class="chat-details">
                <h4>${chat.title}</h4>
                <p>${chat.lastMessage || 'Нет сообщений'}</p>
            </div>
        `;

        chatElement.addEventListener('click', () => openChat(chat.id));
        chatsList.appendChild(chatElement);
    });
}

// Открытие чата
async function openChat(chatId) {
    currentChatId = chatId;
    const chat = await getFromDB('chats', chatId);

    if (!chat) return;

    // Обновляем UI
    document.getElementById('chatPlaceholder').style.display = 'none';
    document.getElementById('activeChat').style.display = 'flex';
    document.getElementById('chatTitle').textContent = chat.title;
    document.getElementById('currentChatAvatar').textContent = chat.avatar;

    // Загружаем сообщения
    await loadMessages(chatId);

    // Подключаемся к пользователю, если есть peerId
    if (chat.peerId && chat.peerId !== userId) {
        connectToPeer(chat.peerId);
    }
}

// Загрузка сообщений
async function loadMessages(chatId) {
    const messages = await getAllFromDB('messages');
    const chatMessages = messages
        .filter(msg => msg.chatId === chatId)
        .sort((a, b) => a.timestamp - b.timestamp);

    const messagesContainer = document.getElementById('messagesContainer');
    messagesContainer.innerHTML = '';

    chatMessages.forEach(displayMessage);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Подключение к другому пользователю
function connectToPeer(peerId) {
    if (currentConnection && currentConnection.open) {
        currentConnection.close();
    }

    updateChatStatus('Подключение...');
    disableMessageInput();

    const conn = peer.connect(peerId, {
        reliable: true,
        serialization: 'json'
    });

    conn.on('open', () => {
        console.log('Соединение установлено с:', peerId);
        currentConnection = conn;
        updateChatStatus('Подключен');
        enableMessageInput();
        sendSystemMessage(`Вы подключились к ${peerId}`);

        // Сохраняем соединение для обработки сообщений
        setupConnectionListeners(conn);
    });

    conn.on('error', (err) => {
        console.error('Ошибка подключения:', err);
        updateChatStatus('Ошибка подключения');
    });
}

// Настройка слушателей соединения
function setupConnectionListeners(conn) {
    conn.on('data', async (data) => {
        await handleIncomingMessage(data);
    });

    conn.on('close', () => {
        console.log('Соединение закрыто');
        updateChatStatus('Соединение разорвано');
        disableMessageInput();
    });
}

// Настройка всех слушателей событий
function setupEventListeners() {
    // Сохранение имени пользователя
    document.getElementById('saveUsername').addEventListener('click', saveUsername);
    document.getElementById('usernameInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') saveUsername();
    });

    // Новый чат
    document.getElementById('newChatBtn').addEventListener('click', showConnectModal);
    document.getElementById('startChatBtn').addEventListener('click', showConnectModal);

    // Подключение к другу
    document.getElementById('connectToFriend').addEventListener('click', connectToFriend);
    document.getElementById('createNewChat').addEventListener('click', createNewChat);
    document.getElementById('closeConnectModal').addEventListener('click', hideConnectModal);

    // Копирование ID
    document.getElementById('copyId').addEventListener('click', copyUserId);

    // Отправка сообщения
    document.getElementById('sendMessageBtn').addEventListener('click', sendMessageHandler);
    document.getElementById('messageInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessageHandler();
        }
    });

    // Индикация печатания
    document.getElementById('messageInput').addEventListener('input', (e) => {
        if (currentConnection && currentConnection.open) {
            currentConnection.send({
                type: 'typing',
                sender: username
            });
        }
    });
}

// Обработчики событий
function saveUsername() {
    const input = document.getElementById('usernameInput').value.trim();
    if (input) {
        username = input;
        document.getElementById('usernameDisplay').textContent = username;
        document.getElementById('userAvatar').textContent = username.charAt(0).toUpperCase();

        saveToDB('user', {
            id: 'currentUser',
            username: username,
            userId: userId
        });

        hideUsernameModal();
    }
}

function sendMessageHandler() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();

    if (message && currentConnection && currentConnection.open) {
        sendMessage(message);
    }
}

async function connectToFriend() {
    const friendId = document.getElementById('friendIdInput').value.trim();
    if (!friendId) {
        alert('Введите ID друга');
        return;
    }

    if (friendId === userId) {
        alert('Нельзя подключиться к самому себе!');
        return;
    }

    hideConnectModal();

    // Проверяем, есть ли уже чат с этим пользователем
    const chatId = generateChatId(userId, friendId);
    let chat = await getFromDB('chats', chatId);

    if (!chat) {
        chat = {
            id: chatId,
            peerId: friendId,
            title: `Чат с ${friendId.substring(0, 8)}`,
            avatar: friendId.charAt(0).toUpperCase(),
            lastActivity: Date.now(),
            unread: 0
        };
        await saveToDB('chats', chat);
        await loadChats();
    }

    openChat(chatId);
    connectToPeer(friendId);
}

async function createNewChat() {
    hideConnectModal();

    const newChatId = generateChatId(userId, 'new_' + Date.now());
    const chat = {
        id: newChatId,
        peerId: null,
        title: 'Новый чат',
        avatar: 'Н',
        lastActivity: Date.now(),
        unread: 0
    };

    await saveToDB('chats', chat);
    await loadChats();
    openChat(newChatId);
}

function copyUserId() {
    navigator.clipboard.writeText(userId).then(() => {
        alert('ID скопирован в буфер обмена!');
    });
}

// Вспомогательные функции
function showUsernameModal() {
    document.getElementById('usernameModal').style.display = 'flex';
}

function hideUsernameModal() {
    document.getElementById('usernameModal').style.display = 'none';
}

function showConnectModal() {
    document.getElementById('connectModal').style.display = 'flex';
}

function hideConnectModal() {
    document.getElementById('connectModal').style.display = 'none';
    document.getElementById('friendIdInput').value = '';
}

function updateConnectionStatus(status) {
    const statusElement = document.getElementById('connectionStatus');
    statusElement.textContent = getStatusText(status);
    statusElement.className = `status-${status}`;
}

function updateChatStatus(status) {
    document.getElementById('chatStatus').textContent = status;
}

function enableMessageInput() {
    document.getElementById('messageInput').disabled = false;
    document.getElementById('sendMessageBtn').disabled = false;
}

function disableMessageInput() {
    document.getElementById('messageInput').disabled = true;
    document.getElementById('sendMessageBtn').disabled = true;
}

function getStatusText(status) {
    const statusMap = {
        'online': 'В сети',
        'offline': 'Не в сети',
        'connecting': 'Подключение...',
        'error': 'Ошибка'
    };
    return statusMap[status] || status;
}

function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit'
    });
}

function generateUserId() {
    return 'user_' + Math.random().toString(36).substr(2, 9);
}

function generateChatId(user1, user2) {
    return [user1, user2].sort().join('_');
}

function generateMessageId() {
    return 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}