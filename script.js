/**
 * SUPABASE CONFIG & INIT
 */
const SUPABASE_URL = (typeof __supabase_url !== 'undefined') ? __supabase_url : 'https://emanyobeiadjfpnwrzku.supabase.co';
const SUPABASE_KEY = (typeof __supabase_key !== 'undefined') ? __supabase_key : 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVtYW55b2JlaWFkamZwbndyemt1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQxMzI4OTEsImV4cCI6MjA3OTcwODg5MX0.CDRCDpbuscHFPx4XD-HT73btAZAazugZWePegTRv6iM';
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

// createClient detection
let createClientFn = null;
if (window.supabase && typeof window.supabase.createClient === 'function') {
    createClientFn = window.supabase.createClient;
} else if (window.Supabase && typeof window.Supabase.createClient === 'function') {
    createClientFn = window.Supabase.createClient;
} else if (window.createClient) {
    createClientFn = window.createClient;
}

if (!createClientFn) {
    console.error('Supabase createClient not found. Make sure the supabase script loaded correctly.');
}

const supabase = createClientFn ? createClientFn(SUPABASE_URL, SUPABASE_KEY) : null;

// Constants
const TABLE_NAME = 'boards';

// State
let currentBoardId = null;
let boardData = []; 
let settings = {};  
let realtimeChannel = null; 
let lastMutationId = null; 

/**
 * INITIALIZATION
 */
async function init() {
    if (!supabase) {
        document.getElementById('loading-spinner').innerText = 'Supabase not initialized';
        return;
    }
    setupOTPInputs();
    renderHistoryUI();
    setupBoard();
}

function setupBoard() {
    const hash = window.location.hash.substring(1);
    
    // Si un code est présent dans l'URL, on charge direct
    if (hash && hash.length > 0) {
        currentBoardId = hash;
        connectToBoard(currentBoardId);
    } else {
        // Sinon, on cache le spinner de chargement et on montre la Landing Page
        document.getElementById('loading-spinner').classList.add('hidden');
        document.getElementById('landing-modal').classList.remove('hidden');
    }
}

async function connectToBoard(boardId) {
    if (realtimeChannel) {
        try {
            if (typeof supabase.removeChannel === 'function') supabase.removeChannel(realtimeChannel);
            else if (typeof realtimeChannel.unsubscribe === 'function') realtimeChannel.unsubscribe();
        } catch (e) { console.warn(e); }
        realtimeChannel = null;
    }

    try {
        const { data, error } = await supabase
            .from(TABLE_NAME)
            .select('board_data,settings,created_at')
            .eq('id', boardId)
            .single();

        document.getElementById('loading-spinner').classList.add('hidden');
        document.getElementById('add-col-container').classList.remove('hidden');

        if (data) {
            boardData = data.board_data || [];
            settings = data.settings || defaultSettings;
            renderBoard();
            addToHistory(boardId);

            if(!document.getElementById('settings-modal').classList.contains('hidden')) renderSettingsList();
            if(currentEditCardId && !document.getElementById('modal-overlay').classList.contains('hidden')) renderModalSidebars();
        } else {
            boardData = defaultBoardData;
            settings = defaultSettings;
            await initializeNewBoard(boardId);
        }
    } catch (err) {
        console.error('Error fetching board:', err);
        showToast('Error connecting to server', 'red');
    }

    // Subscribe to realtime changes
    try {
        realtimeChannel = supabase.channel('public:boards:' + boardId)
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: TABLE_NAME, filter: `id=eq.${boardId}` },
                (payload) => {
                    const eventType = payload.eventType;
                    const newRow = payload.new;

                    if (eventType === 'INSERT' || eventType === 'UPDATE') {
                        if (newRow) {
                            // --- PREDICTION LOGIC (Echo Suppression) ---
                            const serverMutationId = newRow.settings ? newRow.settings.lastMutationId : null;
                            if (serverMutationId && serverMutationId === lastMutationId) {
                                // Echo detecté : on ne fait rien car l'UI est déjà à jour localement !
                                return;
                            }
                            // -------------------------------------------

                            boardData = newRow.board_data || [];
                            settings = newRow.settings || defaultSettings;
                            renderBoard();

                            if(!document.getElementById('settings-modal').classList.contains('hidden')) renderSettingsList();
                            if(currentEditCardId && !document.getElementById('modal-overlay').classList.contains('hidden')) renderModalSidebars();
                        }
                    } else if (eventType === 'DELETE') {
                        boardData = defaultBoardData;
                        settings = defaultSettings;
                        renderBoard();
                    }
                }
            )
            .subscribe();
    } catch (e) {
        console.warn('Realtime subscribe error', e);
    }
}

async function initializeNewBoard(boardId) {
    try {
        const row = {
            id: boardId,
            app_id: appId,
            board_data: boardData,
            settings: settings,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        await supabase.from(TABLE_NAME).insert([row]).select().single();
        console.log('New board initialized');
    } catch (err) {
        console.error('Error inserting new board', err);
    }
}

async function saveToFirebase() {
    if (!supabase || !currentBoardId) return;

    document.getElementById('sync-status').classList.remove('hidden');

    const mutationId = generateId();
    lastMutationId = mutationId;
    if(!settings) settings = {};
    settings.lastMutationId = mutationId;

    const payload = {
        id: currentBoardId,
        app_id: appId,
        board_data: boardData,
        settings: settings,
        updated_at: new Date().toISOString()
    };

    try {
        const { error } = await supabase.from(TABLE_NAME).upsert(payload, { returning: 'minimal' });
        if (error) {
            console.error('Save failed', error);
            showToast('Failed to save changes', 'red');
        } else {
            setTimeout(() => {
                document.getElementById('sync-status').classList.add('hidden');
            }, 500);
        }
    } catch (err) {
        console.error('Save error', err);
        showToast('Failed to save changes', 'red');
    }
}

/**
 * DEFAULT DATA
 */
const defaultBoardData = [
    {
        id: 'col-1',
        title: 'A faire!',
        cards: [
            { id: 'card-1', content: 'Salut! 👋', description: 'Clique sur partager pour travailler à plusieurs sur ce "Tralalero".', labels: ['l1'], members: ['m1'] },
        ]
    },
    { id: 'col-2', title: 'Fait!', cards: [] },
];

const defaultSettings = {
    boardTitle: "Mon Nouveau Tralalero",
    labels: [
        { id: 'l1', colorName: 'red', name: 'Urgent' },
        { id: 'l2', colorName: 'blue', name: 'Dev' },
        { id: 'l3', colorName: 'green', name: 'Design' },
    ],
    members: [
        { id: 'm1', name: 'Par Defaut', initials: 'D', colorName: 'blue' },
    ]
};

// Color Palettes
const LABEL_COLORS = {
    'red': 'bg-red-100 text-red-700 border-red-200',
    'blue': 'bg-blue-100 text-blue-700 border-blue-200',
    'green': 'bg-green-100 text-green-700 border-green-200',
    'yellow': 'bg-yellow-100 text-yellow-700 border-yellow-200',
    'purple': 'bg-purple-100 text-purple-700 border-purple-200',
    'orange': 'bg-orange-100 text-orange-700 border-orange-200',
    'pink': 'bg-pink-100 text-pink-700 border-pink-200',
    'gray': 'bg-slate-100 text-slate-700 border-slate-200',
};

const AVATAR_COLORS = {
    'blue': 'bg-blue-500',
    'emerald': 'bg-emerald-500',
    'violet': 'bg-violet-500',
    'amber': 'bg-amber-500',
    'rose': 'bg-rose-500',
    'cyan': 'bg-cyan-500',
    'slate': 'bg-slate-500',
};

/**
 * HELPERS
 */
function generateId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function getInitials(name) {
    return name.match(/(\b\S)?/g).join("").match(/(^\S|\S$)?/g).join("").toUpperCase();
}

/**
 * SHARE MODAL LOGIC
 */
function shareBoard() {
    if (!currentBoardId) return;

    // 1. Remplir le code dans la modale
    const codeDisplay = document.getElementById('share-code-display');
    codeDisplay.innerText = currentBoardId;

    // 2. Afficher la modale
    document.getElementById('share-modal').classList.remove('hidden');
}

function closeShareModal(e, force) {
    // Ferme si on clique sur le fond (overlay) ou sur le bouton croix (force)
    if (force || e.target.id === 'share-modal') {
        document.getElementById('share-modal').classList.add('hidden');
    }
}

function copyCodeAction() {
    // 1. On construit l'URL complète : https://site.com/ + # + A1B2C3
    // window.location.origin = https://tonsiteweb.com
    // window.location.pathname = / (ou /dossier/ si ce n'est pas à la racine)
    const fullUrl = `${window.location.origin}${window.location.pathname}#${currentBoardId}`;

    // 2. Copie le LIEN dans le presse-papier
    navigator.clipboard.writeText(fullUrl).then(() => {
        
        // Ferme la modale
        document.getElementById('share-modal').classList.add('hidden');
        
        // Affiche le petit toast vert (J'ai changé "Code" par "Lien" pour être précis)
        showToast("Lien copié ! Envoyez-le à votre équipe.", "green");
        
    }).catch(err => {
        console.error('Erreur copie:', err);
        showToast("Erreur lors de la copie", "red");
    });
}

function updateBoardTitle(val) {
    const cleanVal = val.trim();
    if (cleanVal && settings.boardTitle !== cleanVal) {
        settings.boardTitle = cleanVal;
        document.title = `${cleanVal} - Tralalero`; // Change le titre de l'onglet du navigateur
        saveToFirebase(); // Sauvegarde et synchronise
        addToHistory(currentBoardId); // Met à jour l'historique local avec le nouveau nom
    } else if (!cleanVal) {
        // Si vide, on remet l'ancien nom
        document.getElementById('board-title-input').value = settings.boardTitle || "Projet Sans Titre";
    }
}

function showToast(msg, color = "green") {
    const toast = document.getElementById('toast');
    const text = document.getElementById('toast-message');
    text.innerText = msg;
    if(color === "red") {
        toast.querySelector('i').className = "ph-fill ph-warning-circle text-red-400";
    } else {
         toast.querySelector('i').className = "ph-fill ph-check-circle text-green-400";
    }
    toast.classList.remove('opacity-0', 'translate-y-4');
    setTimeout(() => {
         toast.classList.add('opacity-0', 'translate-y-4');
    }, 3000);
}

/**
 * CONFIRM MODAL
 */
function showConfirm(title, message, callback, isDestructive = true) {
    document.getElementById('confirm-title').innerText = title;
    document.getElementById('confirm-message').innerText = message;

    const confirmBtn = document.getElementById('confirm-yes-btn');
    const newBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);

    newBtn.onclick = () => {
        callback();
        closeConfirmModal();
    };

    const iconContainer = document.getElementById('confirm-icon');

    if(isDestructive) {
        newBtn.className = "px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white font-bold shadow-lg shadow-red-500/30 transition w-full";
        newBtn.innerText = "Delete";
        iconContainer.className = "w-12 h-12 rounded-full bg-red-100 text-red-500 flex items-center justify-center mx-auto mb-4";
        iconContainer.innerHTML = '<i class="ph-bold ph-warning text-2xl"></i>';
    } else {
         newBtn.className = "px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold shadow-lg shadow-blue-500/30 transition w-full";
         newBtn.innerText = "Confirm";
         iconContainer.className = "w-12 h-12 rounded-full bg-blue-100 text-blue-500 flex items-center justify-center mx-auto mb-4";
         iconContainer.innerHTML = '<i class="ph-bold ph-info text-2xl"></i>';
    }

    document.getElementById('confirm-modal').classList.remove('hidden');
}

function closeConfirmModal() {
    document.getElementById('confirm-modal').classList.add('hidden');
}

/**
 * RENDER BOARD
 */
function renderBoard() {
    // --- AJOUTER CE BLOC AU DÉBUT DE LA FONCTION ---
    const titleInput = document.getElementById('board-title-input');
    const currentTitle = settings.boardTitle || "Projet Sans Titre";
    
    // On met à jour l'input seulement s'il n'a pas le focus (pour ne pas gêner la frappe)
    if (document.activeElement !== titleInput) {
        titleInput.value = currentTitle;
        document.title = `${currentTitle} - Tralalero`;
    }

    const boardEl = document.getElementById('board');
    const addBtnContainer = document.getElementById('add-col-container');
    const existingCols = boardEl.querySelectorAll('[data-col-id]');
    existingCols.forEach(el => el.remove());

    boardData.forEach((col) => {
        const colEl = document.createElement('div');
        colEl.className = 'flex-shrink-0 w-72 flex flex-col max-h-full transition-transform duration-200';
        colEl.setAttribute('data-col-id', col.id);
        
        // --- DRAG & DROP FOR COLUMNS ---
        colEl.draggable = true;
        colEl.addEventListener('dragstart', handleColDragStart);
        colEl.addEventListener('dragend', handleColDragEnd);
        colEl.addEventListener('dragover', handleDragOver);
        colEl.addEventListener('drop', handleDrop);
        // -------------------------------

        colEl.innerHTML = `
            <div class="bg-white/20 backdrop-blur-md rounded-xl shadow-lg flex flex-col max-h-full border border-white/40">
                <div class="p-3 flex justify-between items-start gap-2 cursor-grab active:cursor-grabbing group">
                    <textarea 
                        onblur="updateColumnTitle('${col.id}', this.value)" 
                        onkeydown="if(event.key === 'Enter') { this.blur(); event.preventDefault(); }"
                        class="bg-transparent font-bold text-slate-700 w-full resize-none h-7 overflow-hidden focus:bg-white focus:px-1 focus:ring-2 focus:ring-blue-500 rounded text-sm truncate leading-7"
                        rows="1"
                    >${col.title}</textarea>
                    <button onclick="deleteColumn('${col.id}')" class="text-slate-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition p-1 rounded hover:bg-slate-200">
                        <i class="ph ph-trash"></i>
                    </button>
                </div>
                <div class="flex-1 overflow-y-auto px-2 pb-2 custom-scrollbar" id="cards-${col.id}"></div>
                <div class="p-2 pt-0">
                     <div id="add-card-btn-${col.id}">
                        <button onclick="showAddCardInput('${col.id}')" class="w-full text-left text-slate-600 hover:bg-white/60 hover:text-slate-900 p-2 rounded-lg transition flex items-center gap-2 text-sm font-medium">
                            <i class="ph ph-plus"></i> Ajouter une carte
                        </button>
                    </div>
                    <div id="add-card-form-${col.id}" class="hidden">
                        <textarea id="input-card-${col.id}" 
                            class="w-full p-2 rounded shadow-sm border border-slate-300 mb-2 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none resize-none" 
                            placeholder="Enter a title..." rows="2"></textarea>
                        <div class="flex items-center gap-2">
                            <button onclick="addCard('${col.id}')" class="bg-blue-600 text-white px-3 py-1.5 rounded text-sm font-medium hover:bg-blue-700">Add</button>
                            <button onclick="hideAddCardInput('${col.id}')" class="text-slate-500 hover:text-slate-700 p-1"><i class="ph ph-x text-lg"></i></button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        boardEl.insertBefore(colEl, addBtnContainer);

        const cardsContainer = colEl.querySelector(`#cards-${col.id}`);
        col.cards.forEach(card => {
            const cardEl = document.createElement('div');
            cardEl.className = 'group relative bg-white p-3 rounded-lg shadow-sm border border-slate-200 mb-2 cursor-grab active:cursor-grabbing hover:shadow-md hover:border-blue-300 transition-all text-sm text-slate-700 select-none';
            cardEl.draggable = true;
            cardEl.setAttribute('data-card-id', card.id);
            cardEl.setAttribute('data-col-id', col.id);

            // Labels
            let labelsHtml = '';
            if(card.labels && card.labels.length > 0) {
                labelsHtml = `<div class="flex flex-wrap gap-1 mb-2">`;
                card.labels.forEach(lId => {
                    const labelObj = (settings.labels || []).find(l => l.id === lId);
                    if(labelObj) {
                        const colorClass = LABEL_COLORS[labelObj.colorName] || LABEL_COLORS['gray'];
                        labelsHtml += `<span class="${colorClass} border px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide">${labelObj.name}</span>`;
                    }
                });
                labelsHtml += `</div>`;
            }

            // Members
            let membersHtml = '';
            if(card.members && card.members.length > 0) {
                membersHtml = `<div class="flex -space-x-1.5 mt-2">`;
                card.members.forEach(mId => {
                    const memObj = (settings.members || []).find(m => m.id === mId);
                    if(memObj) {
                        const colorClass = AVATAR_COLORS[memObj.colorName] || AVATAR_COLORS['slate'];
                        membersHtml += `<div class="w-6 h-6 rounded-full ${colorClass} flex items-center justify-center text-[9px] text-white font-bold ring-2 ring-white" title="${memObj.name}">${memObj.initials}</div>`;
                    }
                });
                membersHtml += `</div>`;
            }

            const descIndicator = card.description ? `<i class="ph ph-text-align-left text-slate-400" title="Has description"></i>` : '';

            cardEl.innerHTML = `
                ${labelsHtml}
                <div class="whitespace-pre-wrap break-words pr-6 font-medium text-slate-800">${card.content}</div>
                <div class="flex items-center justify-between mt-1">
                    <div class="flex items-center gap-2">${descIndicator}</div>
                    ${membersHtml}
                </div>
                <button onclick="openEditModal('${card.id}', '${col.id}')" class="absolute top-2 right-2 text-slate-400 hover:text-blue-500 opacity-0 group-hover:opacity-100 bg-white/80 rounded-full p-1 transition">
                    <i class="ph ph-pencil-simple"></i>
                </button>
            `;

            cardEl.addEventListener('dragstart', handleDragStart);
            cardEl.addEventListener('dragend', handleDragEnd);
            cardsContainer.appendChild(cardEl);
        });
    });
}

/**
 * SETTINGS LOGIC
 */
function openSettingsModal() {
    renderSettingsList();
    document.getElementById('settings-modal').classList.remove('hidden');
}
function closeSettingsModal(e, force) {
    if (force || e.target.id === 'settings-modal') {
        document.getElementById('settings-modal').classList.add('hidden');
    }
}
function renderSettingsList() {
    const labelListEl = document.getElementById('settings-labels-list');
    labelListEl.innerHTML = (settings.labels || []).map(l => {
        const colorClass = LABEL_COLORS[l.colorName];
        return `<div class="flex items-center justify-between bg-white p-2 rounded border border-slate-100 hover:border-slate-300 transition"><div class="flex items-center gap-3"><div class="w-4 h-4 rounded-full ${colorClass.split(' ')[0]} border border-slate-200"></div><span class="font-medium text-sm text-slate-700">${l.name}</span></div><button onclick="removeLabel('${l.id}')" class="text-slate-400 hover:text-red-500 p-1"><i class="ph ph-trash"></i></button></div>`;
    }).join('');

    const pickerEl = document.getElementById('label-color-picker');
    pickerEl.innerHTML = Object.keys(LABEL_COLORS).map(colorKey => {
        const bgClass = LABEL_COLORS[colorKey].split(' ')[0];
        return `<div onclick="selectLabelColor('${colorKey}')" class="w-6 h-6 rounded-full ${bgClass} cursor-pointer ring-2 ring-offset-1 transition hover:scale-110 ${document.getElementById('selected-label-color').value === colorKey ? 'ring-blue-500' : 'ring-transparent border border-slate-200'}"></div>`;
    }).join('');

    const memberListEl = document.getElementById('settings-members-list');
    memberListEl.innerHTML = (settings.members || []).map(m => {
        const colorClass = AVATAR_COLORS[m.colorName];
        return `<div class="flex items-center justify-between bg-white p-2 rounded border border-slate-100 hover:border-slate-300 transition"><div class="flex items-center gap-3"><div class="w-6 h-6 rounded-full ${colorClass} text-white flex items-center justify-center text-[10px] font-bold">${m.initials}</div><span class="font-medium text-sm text-slate-700">${m.name}</span></div><button onclick="removeMember('${m.id}')" class="text-slate-400 hover:text-red-500 p-1"><i class="ph ph-trash"></i></button></div>`;
    }).join('');
}
function selectLabelColor(color) { document.getElementById('selected-label-color').value = color; renderSettingsList(); }

function addNewLabel() {
    const nameInput = document.getElementById('new-label-name'); const name = nameInput.value.trim();
    const color = document.getElementById('selected-label-color').value;
    if (name) {
        if(!settings.labels) settings.labels = [];
        settings.labels.push({ id: 'l-' + generateId(), name: name, colorName: color });
        nameInput.value = ''; saveToFirebase(); renderSettingsList();
    }
}
function removeLabel(id) {
    showConfirm("Delete Label?", "This label will be removed from all cards.", () => {
        settings.labels = settings.labels.filter(l => l.id !== id);
        boardData.forEach(col => { col.cards.forEach(card => { card.labels = (card.labels || []).filter(lId => lId !== id); }); });
        saveToFirebase(); renderSettingsList();
    });
}
function addNewMember() {
    const nameInput = document.getElementById('new-member-name'); const name = nameInput.value.trim();
    if (name) {
        const colorKeys = Object.keys(AVATAR_COLORS);
        const randomColor = colorKeys[Math.floor(Math.random() * colorKeys.length)];
        if(!settings.members) settings.members = [];
        settings.members.push({ id: 'm-' + generateId(), name: name, initials: getInitials(name), colorName: randomColor });
        nameInput.value = ''; saveToFirebase(); renderSettingsList();
    }
}
function removeMember(id) {
    showConfirm("Remove Member?", "They will be unassigned from all tasks.", () => {
        settings.members = settings.members.filter(m => m.id !== id);
        boardData.forEach(col => { col.cards.forEach(card => { card.members = (card.members || []).filter(mId => mId !== id); }); });
        saveToFirebase(); renderSettingsList();
    });
}

/**
 * CARD EDITING
 */
let currentEditCardId = null, currentEditColId = null;
let tempLabels = [], tempMembers = [];

function openEditModal(cardId, colId) {
    const col = boardData.find(c => c.id === colId);
    const card = col.cards.find(c => c.id === cardId);
    currentEditCardId = cardId; currentEditColId = colId;
    tempLabels = [...(card.labels || [])];
    tempMembers = [...(card.members || [])];

    document.getElementById('modal-title-input').value = card.content;
    document.getElementById('modal-desc-input').value = card.description || '';
    document.getElementById('modal-list-name').innerText = col.title;
    renderModalSidebars();
    document.getElementById('modal-overlay').classList.remove('hidden');
}
function renderModalSidebars() {
    document.getElementById('modal-labels-container').innerHTML = (settings.labels || []).map(label => {
        const isSelected = tempLabels.includes(label.id);
        const colorClass = LABEL_COLORS[label.colorName];
        return `<button onclick="toggleLabel('${label.id}')" class="h-7 px-2.5 rounded text-xs font-bold transition flex items-center gap-2 border ${colorClass} ${isSelected ? 'ring-2 ring-offset-1 ring-blue-400 opacity-100' : 'opacity-60 hover:opacity-100'}">${label.name} ${isSelected ? '<i class="ph-bold ph-check"></i>' : ''}</button>`;
    }).join('');
    document.getElementById('modal-members-container').innerHTML = (settings.members || []).map(mem => {
        const isSelected = tempMembers.includes(mem.id);
        const colorClass = AVATAR_COLORS[mem.colorName];
        return `<button onclick="toggleMember('${mem.id}')" class="w-full flex items-center gap-3 p-1.5 rounded-lg transition ${isSelected ? 'bg-blue-50 text-blue-700' : 'hover:bg-slate-100 text-slate-600'}"><div class="w-6 h-6 rounded-full ${colorClass} flex items-center justify-center text-[10px] text-white font-bold">${mem.initials}</div><span class="text-sm font-medium flex-1 text-left">${mem.name}</span>${isSelected ? '<i class="ph-bold ph-check text-blue-600"></i>' : ''}</button>`;
    }).join('');
}
function toggleLabel(id) { tempLabels = tempLabels.includes(id) ? tempLabels.filter(l => l !== id) : [...tempLabels, id]; renderModalSidebars(); }
function toggleMember(id) { tempMembers = tempMembers.includes(id) ? tempMembers.filter(m => m !== id) : [...tempMembers, id]; renderModalSidebars(); }

function saveCardFromModal() {
    if(!currentEditCardId) return;
    const col = boardData.find(c => c.id === currentEditColId);
    const card = col.cards.find(c => c.id === currentEditCardId);
    card.content = document.getElementById('modal-title-input').value.trim() || "Untitled";
    card.description = document.getElementById('modal-desc-input').value.trim();
    card.labels = tempLabels; card.members = tempMembers;
    saveToFirebase(); closeModal(null, true);
    renderBoard(); // Update UI immediately
}
function deleteCardFromModal() {
    if(!currentEditCardId) return;
    showConfirm("Delete Card?", "This card will be removed permanently.", () => {
        const col = boardData.find(c => c.id === currentEditColId);
        col.cards = col.cards.filter(c => c.id !== currentEditCardId);
        saveToFirebase(); closeModal(null, true);
        renderBoard(); // Update UI immediately
    });
}
function closeModal(e, force) { if(force || e.target.id === 'modal-overlay') { document.getElementById('modal-overlay').classList.add('hidden'); currentEditCardId = null; } }

/**
 * BASIC ACTIONS (FIXED: Added renderBoard() everywhere)
 */
function showAddColumnInput(btn) { btn.classList.add('hidden'); document.getElementById('add-col-form').classList.remove('hidden'); document.getElementById('new-col-title').focus(); }
function hideAddColumnInput() { document.getElementById('add-col-form').classList.add('hidden'); document.getElementById('add-col-btn').classList.remove('hidden'); document.getElementById('new-col-title').value = ''; }

function createColumn() {
    const title = document.getElementById('new-col-title').value.trim(); if (!title) return;
    boardData.push({ id: 'col-' + generateId(), title: title, cards: [] });
    renderBoard(); // <--- FIX: Show instantly
    saveToFirebase(); hideAddColumnInput();
}

function deleteColumn(colId) { 
    showConfirm("Delete List?", "This will delete the list and cards.", () => { 
        boardData = boardData.filter(c => c.id !== colId); 
        renderBoard(); // <--- FIX: Show instantly
        saveToFirebase(); 
    }); 
}

function updateColumnTitle(colId, val) { 
    const col = boardData.find(c => c.id === colId); 
    if(val.trim()) { 
        col.title = val; 
        saveToFirebase(); 
        // No render needed here as input is already updating visually
    } else {
        renderBoard(); 
    }
}

function showAddCardInput(colId) { document.getElementById(`add-card-btn-${colId}`).classList.add('hidden'); document.getElementById(`add-card-form-${colId}`).classList.remove('hidden'); const i = document.getElementById(`input-card-${colId}`); i.focus(); i.onkeydown = (e) => { if(e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addCard(colId); }}; }
function hideAddCardInput(colId) { document.getElementById(`add-card-btn-${colId}`).classList.remove('hidden'); document.getElementById(`add-card-form-${colId}`).classList.add('hidden'); document.getElementById(`input-card-${colId}`).value = ''; }

function addCard(colId) { 
    const val = document.getElementById(`input-card-${colId}`).value.trim(); 
    if(!val) return; 
    const col = boardData.find(c => c.id === colId); 
    col.cards.push({ id: 'card-' + generateId(), content: val, description: "", labels: [], members: [] }); 
    renderBoard(); // <--- FIX: Show instantly
    saveToFirebase(); 
    hideAddCardInput(colId); 
}

/**
 * DRAG & DROP SYSTEM (Cards + Columns)
 */
let draggedCardId = null;
let draggedColId = null;
let draggedType = null; // 'CARD' or 'COL'
let sourceColId = null;

// --- COLUMNS ---
function handleColDragStart(e) {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'BUTTON' || e.target.closest('button')) {
        e.preventDefault();
        return;
    }
    draggedType = 'COL';
    draggedColId = this.getAttribute('data-col-id');
    this.classList.add('opacity-50', 'scale-95'); 
    e.dataTransfer.effectAllowed = 'move';
}

function handleColDragEnd(e) {
    this.classList.remove('opacity-50', 'scale-95');
    draggedColId = null;
    draggedType = null;
    renderBoard();
}

// --- CARDS ---
function handleDragStart(e) {
    e.stopPropagation(); 
    draggedType = 'CARD';
    draggedCardId = this.getAttribute('data-card-id');
    sourceColId = this.getAttribute('data-col-id');
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedCardId);
}

function handleDragEnd(e) {
    this.classList.remove('dragging');
    document.querySelectorAll('.card-ghost').forEach(el => el.remove());
    draggedCardId = null;
    draggedType = null;
}

// --- COMMON DROP ZONE ---
function handleDragOver(e) {
    e.preventDefault();
    
    // 1. Dragging a CARD
    if (draggedType === 'CARD') {
        const container = this.querySelector('div[id^="cards-"]');
        if (!container) return; 

        const after = getDragAfterCard(container, e.clientY);
        let ghost = document.querySelector('.card-ghost');
        if (!ghost) {
            ghost = document.createElement('div');
            ghost.className = 'card-ghost h-10 bg-slate-100/50 border-2 border-dashed border-slate-300 rounded-lg mb-2 mx-1';
        }
        if (after) {
            container.insertBefore(ghost, after);
        } else {
            container.appendChild(ghost);
        }
    } 
    // 2. Dragging a COLUMN (SWAP / HIT-TEST Logic)
    else if (draggedType === 'COL') {
        const boardEl = document.getElementById('board');
        const target = e.target.closest('[data-col-id]');
        const draggingCol = document.querySelector(`[data-col-id="${draggedColId}"]`);
        
        if (target && draggingCol && target !== draggingCol) {
            const children = Array.from(boardEl.children);
            const dragIdx = children.indexOf(draggingCol);
            const targetIdx = children.indexOf(target);

            if (dragIdx < targetIdx) {
                boardEl.insertBefore(draggingCol, target.nextElementSibling);
            } else {
                boardEl.insertBefore(draggingCol, target);
            }
        }
    }
}

function handleDrop(e) {
    e.preventDefault();
    
    // 1. Dropping a CARD
    if (draggedType === 'CARD' && draggedCardId && sourceColId) {
        const destColId = this.getAttribute('data-col-id');
        const container = this.querySelector('div[id^="cards-"]');
        const ghost = document.querySelector('.card-ghost');
        
        let newIndex = 0;
        if (container && ghost) {
            newIndex = Array.from(container.children).indexOf(ghost);
            ghost.remove(); 
        }

        const sCol = boardData.find(c => c.id === sourceColId);
        const card = sCol.cards.find(c => c.id === draggedCardId);
        
        sCol.cards = sCol.cards.filter(c => c.id !== draggedCardId);
        const dCol = boardData.find(c => c.id === destColId);
        
        if (newIndex < 0 || newIndex > dCol.cards.length) {
            dCol.cards.push(card);
        } else {
            dCol.cards.splice(newIndex, 0, card);
        }
        
        saveToFirebase();
        renderBoard();
    }
    
    // 2. Dropping a COLUMN
    else if (draggedType === 'COL' && draggedColId) {
        const boardEl = document.getElementById('board');
        const allCols = Array.from(boardEl.querySelectorAll('[data-col-id]'));
        const newIndex = allCols.findIndex(el => el.getAttribute('data-col-id') === draggedColId);
        
        if (newIndex >= 0) {
            const colItem = boardData.find(c => c.id === draggedColId);
            const oldData = boardData.filter(c => c.id !== draggedColId);
            oldData.splice(newIndex, 0, colItem);
            
            boardData = oldData;
            saveToFirebase();
        }
    }
}

// Helpers
function getDragAfterCard(container, y) {
    const draggables = [...container.querySelectorAll('[data-card-id]:not(.dragging)')];
    return draggables.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

/**
 * LANDING PAGE LOGIC
 */

async function createNewBoardAction() {
    const newId = generateId();
    currentBoardId = newId;
    window.location.hash = newId;

    // 1. UI Immédiate : On ferme le modal et on montre le loader un court instant
    document.getElementById('landing-modal').classList.add('hidden');
    
    // 2. IMPORTANT : On charge les données par défaut localement TOUT DE SUITE
    // On utilise JSON.parse/stringify pour créer une "copie profonde" et éviter les bugs de référence
    boardData = JSON.parse(JSON.stringify(defaultBoardData));
    settings = JSON.parse(JSON.stringify(defaultSettings));

    // 3. On affiche le tableau immédiatement (Optimistic UI)
    renderBoard();
    if(!document.getElementById('settings-modal').classList.contains('hidden')) renderSettingsList();
    
    // On montre l'interface principale (au cas où elle était cachée)
    document.getElementById('loading-spinner').classList.add('hidden');
    document.getElementById('add-col-container').classList.remove('hidden');

    // 4. On sauvegarde dans la base de données en arrière-plan
    // On appelle initializeNewBoard mais on n'a pas besoin d'attendre la réponse pour afficher l'UI
    try {
        await initializeNewBoard(newId);
        
        // 5. Une fois créé, on se connecte au canal temps réel pour les futures mises à jour
        connectToBoard(newId); 
    } catch (e) {
        console.error("Erreur lors de la création initiale", e);
        showToast("Erreur lors de la création du tableau", "red");
    }
}

async function checkAndJoinBoard() {
    const errorMsg = document.getElementById('join-error');
    
    // Récupération du code (comme vu avant)
    const inputs = document.querySelectorAll('.otp-input');
    let code = '';
    inputs.forEach(input => {
        code += input.value.trim();
        input.classList.remove('border-red-500', 'ring-red-500');
    });
    code = code.toUpperCase();

    // Reset UI
    errorMsg.classList.add('hidden');

    if (!code || code.length < 6) {
        showJoinError("Le code doit contenir 6 caractères.");
        return;
    }

    // --- UI Loading state (Adapté) ---
    inputs.forEach(i => i.disabled = true);

    try {
        const { data, error } = await supabase
            .from(TABLE_NAME)
            .select('id')
            .eq('id', code)
            .single();

        if (error || !data) {
            showJoinError("Ce tableau n'existe pas.");
            
            inputs.forEach(i => {
                i.disabled = false;
                i.value = '';
            });
            inputs[0].focus();
        } else {
            
            currentBoardId = code;
            window.location.hash = code;
            
            // Petit délai esthétique pour voir le "Connecté"
            setTimeout(() => {
                document.getElementById('landing-modal').classList.add('hidden');
                document.getElementById('loading-spinner').classList.remove('hidden');
                connectToBoard(code);
                // Réactiver les inputs pour la prochaine fois (si logout)
                inputs.forEach(i => i.disabled = false);
            }, 500);
        }

    } catch (err) {
        console.error(err);
        showJoinError("Erreur de connexion.");
        inputs.forEach(i => i.disabled = false);
    }
}

// MODIFIER showJoinError pour colorer les 6 cases en rouge
function showJoinError(msg) {
    const errorMsg = document.getElementById('join-error');
    errorMsg.innerText = msg;
    errorMsg.classList.remove('hidden');
    
    // Ajoute une bordure rouge aux inputs
    const inputs = document.querySelectorAll('.otp-input');
    inputs.forEach(input => input.classList.add('border-red-500', 'ring-1', 'ring-red-500'));
}

function setupOTPInputs() {
    const container = document.getElementById('otp-container');
    if(!container) return;
    
    const inputs = container.querySelectorAll('.otp-input');

    inputs.forEach((input, index) => {
        // 1. Gérer la saisie
        input.addEventListener('input', (e) => {
            const val = e.target.value;
            
            // Si on a tapé un caractère
            if (val.length === 1) {
                // Focus le suivant si existe
                if (index < inputs.length - 1) {
                    inputs[index + 1].focus();
                } else {
                    // C'était le dernier ? On tente de valider
                    checkAndJoinBoard();
                }
            } 
            // Cas particulier : si l'utilisateur tape vite ou système autocomplete
            else if (val.length > 1) {
                e.target.value = val[0]; // On garde que le premier char
                if (index < inputs.length - 1) inputs[index + 1].focus();
            }
        });

        // 2. Gérer le Backspace et les flèches
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && !e.target.value) {
                if (index > 0) {
                    inputs[index - 1].focus();
                }
            }
            if (e.key === 'ArrowLeft' && index > 0) {
                inputs[index - 1].focus();
            }
            if (e.key === 'ArrowRight' && index < inputs.length - 1) {
                inputs[index + 1].focus();
            }
            if (e.key === 'Enter') {
                checkAndJoinBoard();
            }
        });

        // 3. Gérer le Coller (Paste) d'un code complet (ex: "A1B2C3")
        input.addEventListener('paste', (e) => {
            e.preventDefault();
            const pasteData = (e.clipboardData || window.clipboardData).getData('text');
            const cleanData = pasteData.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 6);
            
            if (cleanData) {
                cleanData.split('').forEach((char, i) => {
                    if (inputs[i]) inputs[i].value = char;
                });
                
                // Focus sur la dernière case remplie ou la suivante vide
                const nextEmptyIndex = cleanData.length < 6 ? cleanData.length : 5;
                inputs[nextEmptyIndex].focus();

                // Si complet, on lance
                if (cleanData.length === 6) {
                    checkAndJoinBoard();
                }
            }
        });

        // Force Uppercase visuel à la saisie
        input.addEventListener('keyup', function() {
            this.value = this.value.toUpperCase();
        });
    });
}

/**
 * HISTORY MANAGER (LocalStorage)
 */
function addToHistory(boardId) {
    if (!boardId) return;
    
    let history = JSON.parse(localStorage.getItem('tralalero_history') || '[]');
    
    // On récupère le titre actuel (ou "Projet inconnu" si pas encore chargé)
    const title = (settings && settings.boardTitle) ? settings.boardTitle : "Chargement...";

    const entry = {
        id: boardId,
        title: title, // <--- On sauvegarde le titre
        date: new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
    };

    // Supprimer l'ancienne entrée pour cet ID
    history = history.filter(h => h.id !== boardId);
    
    // Ajouter au début
    history.unshift(entry);
    
    if (history.length > 5) history.pop();
    
    localStorage.setItem('tralalero_history', JSON.stringify(history));
    
    // Si on est encore sur la page d'accueil, on rafraichit la liste
    renderHistoryUI(); 
}

function renderHistoryUI() {
    const history = JSON.parse(localStorage.getItem('tralalero_history') || '[]');
    const container = document.getElementById('history-container');
    const listItemsContainer = document.getElementById('history-list-items');
    
    // Si pas d'historique, on cache tout
    if (history.length === 0) {
        container.classList.add('hidden');
        return;
    }

    // Sinon, on affiche
    container.classList.remove('hidden');
    listItemsContainer.innerHTML = ''; // On vide la liste

    history.forEach(item => {
        const displayTitle = item.title ? item.title : `Code: ${item.id}`;
        
        // Création de l'élément visuel
        const el = document.createElement('button');
        el.className = "w-full text-left px-3 py-3 rounded-lg text-white/90 bg-slate-700 hover:text-white transition flex items-center gap-3 group";
        el.onclick = () => selectHistoryItem(item.id);
        
        el.innerHTML = `
            <div class="w-8 h-8 rounded-full bg-indigo-500/30 flex items-center justify-center border border-white/10 group-hover:border-white/30 transition">
                <i class="ph-fill ph-kanban text-indigo-300"></i>
            </div>
            <div class="flex-1 min-w-0">
                <div class="font-bold text-sm truncate">${displayTitle}</div>
                <div class="text-[10px] text-white/50 font-mono tracking-wider">CODE: ${item.id} • ${item.date}</div>
            </div>
            <i class="ph-bold ph-arrow-right opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition"></i>
        `;
        listItemsContainer.appendChild(el);
    });
}

function toggleHistoryDropdown() {
    const dropdown = document.getElementById('history-dropdown');
    const icon = document.querySelector('#history-trigger i');
    
    if (dropdown.classList.contains('hidden')) {
        // Ouvrir
        dropdown.classList.remove('hidden');
        dropdown.classList.add('animate-fade-in-down'); // Assure-toi que cette classe existe ou utilise une transition simple
        icon.classList.add('rotate-180');
    } else {
        // Fermer
        dropdown.classList.add('hidden');
        dropdown.classList.remove('animate-fade-in-down');
        icon.classList.remove('rotate-180');
    }
}

function selectHistoryItem(boardId) {
    // 1. Fermer le menu
    toggleHistoryDropdown();
    
    // 2. Mettre à jour le texte du bouton (feedback visuel)
    document.getElementById('history-selected-text').innerText = "Chargement...";
    
    // 3. Charger
    loadFromHistory(boardId);
}

window.addEventListener('click', function(e) {
    const container = document.getElementById('history-container');
    const dropdown = document.getElementById('history-dropdown');
    const trigger = document.getElementById('history-trigger');
    
    if (!container.contains(e.target) && !dropdown.classList.contains('hidden')) {
        dropdown.classList.add('hidden');
        trigger.querySelector('i').classList.remove('rotate-180');
    }
});

function loadFromHistory(val) {
    if (!val) return;
    
    // Simuler le remplissage des inputs OTP
    const inputs = document.querySelectorAll('.otp-input');
    val.split('').forEach((char, i) => {
        if(inputs[i]) inputs[i].value = char;
    });
    
    // Lancer la connexion
    checkAndJoinBoard();
}

function leaveBoard() {
    // On enlève le hash de l'URL et on recharge la page
    window.location.hash = '';
    window.location.reload();
}

async function deleteBoardAction() {
    if (!currentBoardId) return;

    // On utilise ta modale de confirmation existante
    showConfirm(
        "Supprimer définitivement ?", 
        "Attention : Ce projet sera effacé pour tout le monde. Cette action est irréversible.", 
        async () => {
            // 1. Suppression dans Supabase
            const { error } = await supabase
                .from(TABLE_NAME)
                .delete()
                .eq('id', currentBoardId);

            if (error) {
                console.error('Erreur de suppression:', error);
                showToast("Erreur lors de la suppression.", "red");
                return;
            }

            // 2. Suppression de l'historique local (LocalStorage)
            removeFromHistory(currentBoardId);

            // 3. Feedback visuel et retour accueil
            showToast("Projet supprimé avec succès.", "green");
            
            // Petit délai pour lire le message avant de recharger
            setTimeout(() => {
                leaveBoard(); // Retour à la case départ
            }, 1000);
        }, 
        true // isDestructive = true (bouton rouge dans la modale)
    );
}

// Petite fonction utilitaire pour nettoyer le localStorage
function removeFromHistory(boardId) {
    let history = JSON.parse(localStorage.getItem('tralalero_history') || '[]');
    // On garde tout SAUF l'id qu'on vient de supprimer
    history = history.filter(h => h.id !== boardId);
    localStorage.setItem('tralalero_history', JSON.stringify(history));
}

init();