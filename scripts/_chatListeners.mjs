import { LIMIT, MODULE, TRUST_MODE, TRUST_OPTIONS } from "./_constants.mjs";
import { closeAllPopouts } from "./_popoutHelpers.mjs";

// add event listener to chat log.
export function onClickButton(chatLog, html) {
  const hookLogPrefix = "Requestor|hook";
  const root = html?.[0] ?? html; // renderChatLog uses jQuery, popouts may pass HTMLElement
  if (!root) {
    console.warn(`${hookLogPrefix} missing html root`, { chatLogType: chatLog?.constructor?.name });
    return;
  }
  console.debug(`${hookLogPrefix} binding click handler`, {
    chatLogType: chatLog?.constructor?.name,
    node: root?.tagName,
    hasPopout: !!root?.closest?.(".app")
  });

  root.addEventListener("click", async (event) => {
    const logPrefix = "Requestor|click";
    console.debug(`${logPrefix} captured`, {
      target: event?.target?.outerHTML ?? event?.target?.tagName,
      pathLength: event?.composedPath?.().length
    });

    // make sure it's a Requestor button.
    const button = event.target?.closest(`button[id="${MODULE}"]`);
    if (!button) {
      return;
    }

    // get the button index (starting at 0).
    const buttonIndex = Number(button.dataset.index);

    // find the chat message element and document data safely.
    const messageContainer = button.closest("[data-message-id]");
    if (!messageContainer) {
      console.warn(`${logPrefix} missing message container`, { buttonIndex });
      return;
    }
    const messageId = messageContainer.dataset.messageId;
    const message = game.messages.get(messageId);
    if (!message) {
      console.warn(`${logPrefix} message not found`, { messageId, buttonIndex });
      return;
    }

    // get the args.
    const buttonData = message.getFlag(MODULE, "args.buttonData") ?? [];
    if (!Array.isArray(buttonData)) {
      console.warn(`${logPrefix} buttonData is not an array`, { messageId, buttonData });
      return;
    }
    const args = buttonData[buttonIndex];
    if (!args?.action) {
      console.warn(`${logPrefix} missing action`, { messageId, buttonIndex, args });
      return;
    }
    const limit = args.limit;

    console.debug(`${logPrefix} button ready`, { messageId, buttonIndex, limit, args });

    // if it is only allowed to be clicked once, and is already clicked, bail out.
    const clickedKey = `messageIds.${messageId}.${buttonIndex}.clicked`;
    const clickedButton = !!game.user.getFlag(MODULE, clickedKey);
    if ((limit === LIMIT.ONCE) && clickedButton) return;

    // if it is one of several options, and an option on this message has already been clicked, bail out.
    const clickedOptionKey = `messageIds.${messageId}.clickedOption`;
    const clickedCardOption = !!game.user.getFlag(MODULE, clickedOptionKey);
    if ((limit === LIMIT.OPTION) && clickedCardOption) return;

    // bail out if user is not allowed to click this button.
    const trustMode = game.settings.get(MODULE, TRUST_MODE);
    const messageAuthor = message.user ?? game.users.get(message.userId);
    const authorIsGM = messageAuthor?.isGM ?? false;
    if (!authorIsGM) {
      if (trustMode === TRUST_OPTIONS.GM_ONLY) {
        const string = "REQUESTOR.WARN.GM_ONLY";
        const warning = game.i18n.localize(string);
        ui.notifications.warn(warning);
        return;
      }
      if (trustMode === TRUST_OPTIONS.GM_OWN) {
        if (messageAuthor?.id !== game.user.id) {
          const string = "REQUESTOR.WARN.GM_OR_OWN_ONLY";
          const warning = game.i18n.localize(string);
          ui.notifications.warn(warning);
          return;
        }
      }
    }

    // turn the card's embedded flag into a function.
    const body = `(
        ${args.action}
      )();`;
    const fn = Function("token", "character", "actor", "scene", "amount", "event", "args", body);

    // define helper variables.
    let character = game.user.character;
    let token = canvas.tokens.controlled[0] ?? character?.getActiveTokens()[0];
    let actor = token?.actor ?? character;
    let scene = canvas?.scene;

    let amount = "";
    if ('amount' in args) {
      amount = args.amount;
    }

    if ('actor_from_token_ID' in args) {
      let target_token = canvas.tokens.get(args.actor_from_token_ID)
      actor = target_token.actor;
    }
    
    // if button is unlimited, remove disabled attribute.
    if (limit === LIMIT.FREE) button.disabled = false;

    // if button is limited, flag user as having clicked this button.
    else if (limit === LIMIT.ONCE) {
      const key = `messageIds.${messageId}.${buttonIndex}.clicked`;
      await game.user.setFlag(MODULE, key, true);
      setMessageDisabledStates(message);
    }

    // if button is one of several options, flag user as having clicked an option on this card.
    else if (limit === LIMIT.OPTION) {
      const key = `messageIds.${messageId}.clickedOption`;
      await game.user.setFlag(MODULE, key, true);
      setMessageDisabledStates(message);
    }

    // if message context is set to close on button clicks, close all popouts.
    if (message.getFlag(MODULE, "args.context.autoClose")) {
      closeAllPopouts(message);
    }

    // set up 'this'
    const THIS = foundry.utils.duplicate(args);
    delete THIS.limit;
    delete THIS.action;
    delete THIS.label;

    // execute the embedded function.
    try {
      console.debug(`${logPrefix} executing`, { messageId, buttonIndex });
      return fn.call(THIS, token, character, actor, scene, amount, event, THIS);
    } catch (error) {
      console.error(`${logPrefix} error executing button`, { messageId, buttonIndex, error });
    }
  });
}

// set disabled state of buttons when a message is rendered.
export function setMessageDisabledStates(message, html) {
  if (!message) {
    console.warn("Requestor|disable missing message");
    return;
  }

  const root = html?.[0] ?? html;
  const nodes = root ? [root] : Array.from(document.querySelectorAll(`[data-message-id="${message.id}"]`));

  nodes.forEach(node => {

    // if the message is found, get all of its buttons.
    const buttons = node.querySelectorAll(`button[id="${MODULE}"]`);
    console.debug("Requestor|disable evaluating buttons", { messageId: message.id, buttonCount: buttons.length });

    // for each button, if the button is limited and clicked, set it to be disabled.
    // if a button is an option, and the user has clicked an option on this card, set it to be disabled.
    for (const button of buttons) {
      // get the index of the button to find the user's flag.
      const buttonIndex = button.dataset.index;

      // this flag only exists if a ONCE button has been clicked.
      const keyClicked = `messageIds.${message.id}.${buttonIndex}.clicked`;
      if (game.user.getFlag(MODULE, keyClicked)) button.disabled = true;

      // if OPTION, and an option has been clicked, disable the button.
      const keyOption = `messageIds.${message.id}.clickedOption`;
      const hasClickedOption = game.user.getFlag(MODULE, keyOption);
      const messageButtonDataArray = message.getFlag(MODULE, "args.buttonData");
      if (hasClickedOption && messageButtonDataArray.length > 0) {
        const { limit } = messageButtonDataArray[buttonIndex];
        if (limit === LIMIT.OPTION) button.disabled = true;
      }
    }
  });
}

// initial disabled state of buttons when logging in.
export function initialDisable() {
  const ids = Object.keys(game.user.getFlag(MODULE, "messageIds") ?? {});
  console.debug("Requestor|initialDisable", { ids });
  for (const id of ids) {
    const message = game.messages.get(id);
    if (!message) continue;
    const messageHTML = document.querySelector(`[data-message-id="${id}"]`);
    const buttons = messageHTML.querySelectorAll(`button[id="${MODULE}"]`);
    for (const button of buttons) {
      const buttonIndex = button.dataset.index;
      const keyClicked = `messageIds.${id}.${buttonIndex}.clicked`;
      if (game.user.getFlag(MODULE, keyClicked)) button.disabled = true;

      const keyOption = `messageIds.${id}.clickedOption`;
      const hasClickedOption = game.user.getFlag(MODULE, keyOption);
      const messageButtonDataArray = message.getFlag(MODULE, "args.buttonData");
      if (hasClickedOption && messageButtonDataArray.length) {
        const { limit } = messageButtonDataArray[buttonIndex];
        if (limit === LIMIT.OPTION) button.disabled = true;
      }
    }
  }
}
