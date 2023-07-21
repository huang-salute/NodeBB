'use strict';

const winston = require('winston');

const batch = require('../batch');
const db = require('../database');
const notifications = require('../notifications');
const io = require('../socket.io');
const plugins = require('../plugins');
const meta = require('../meta');

module.exports = function (Messaging) {
	// Only used to notify a user of a new chat message
	Messaging.notifyQueue = {};
	Messaging.notifyUsersInRoom = async (fromUid, roomId, messageObj) => {
		const isPublic = parseInt(await db.getObjectField(`chat:room:${roomId}`, 'public'), 10) === 1;

		let data = {
			roomId: roomId,
			fromUid: fromUid,
			message: messageObj,
			public: isPublic,
		};
		data = await plugins.hooks.fire('filter:messaging.notify', data);
		if (!data) {
			return;
		}

		// delivers full message to all online users in roomId
		io.in(`chat_room_${roomId}`).emit('event:chats.receive', data);

		const unreadData = { roomId, fromUid, public: isPublic };
		if (isPublic && !messageObj.system) {
			// delivers unread public msg to all online users on the chats page
			io.in(`chat_room_public_${roomId}`).emit('event:chats.public.unread', unreadData);
		}
		if (messageObj.system || isPublic) {
			return;
		}

		// push unread count only for private rooms
		const uids = await Messaging.getAllUidsInRoomFromSet(`chat:room:${roomId}:uids:online`);
		Messaging.pushUnreadCount(uids, unreadData);

		// Delayed notifications
		let queueObj = Messaging.notifyQueue[`${fromUid}:${roomId}`];
		if (queueObj) {
			queueObj.message.content += `\n${messageObj.content}`;
			clearTimeout(queueObj.timeout);
		} else {
			queueObj = {
				message: messageObj,
			};
			Messaging.notifyQueue[`${fromUid}:${roomId}`] = queueObj;
		}

		queueObj.timeout = setTimeout(async () => {
			try {
				await sendNotification(fromUid, roomId, queueObj.message);
				delete Messaging.notifyQueue[`${fromUid}:${roomId}`];
			} catch (err) {
				winston.error(`[messaging/notifications] Unabled to send notification\n${err.stack}`);
			}
		}, meta.config.notificationSendDelay * 1000);
	};

	async function sendNotification(fromUid, roomId, messageObj) {
		const { displayname } = messageObj.fromUser;
		const isGroupChat = await Messaging.isGroupChat(roomId);
		const notification = await notifications.create({
			type: isGroupChat ? 'new-group-chat' : 'new-chat',
			subject: `[[email:notif.chat.subject, ${displayname}]]`,
			bodyShort: `[[notifications:new_message_from, ${displayname}]]`,
			bodyLong: messageObj.content,
			nid: `chat_${fromUid}_${roomId}`,
			from: fromUid,
			path: `/chats/${messageObj.roomId}`,
		});

		await batch.processSortedSet(`chat:room:${roomId}:uids:online`, async (uids) => {
			const hasRead = await Messaging.hasRead(uids, roomId);
			uids = uids.filter((uid, index) => !hasRead[index] && parseInt(fromUid, 10) !== parseInt(uid, 10));

			notifications.push(notification, uids);
		}, {
			reverse: true,
			batch: 500,
			interval: 1000,
		});
	}
};
