// SPDX-License-Identifier: MIT
// Modified from OpenZeppelin Contracts (v5.6.0) (utils/structs/DoubleEndedQueue.sol)
// Changes: uses `bytes` values instead of `bytes32` to support variable-length encoded structs.
pragma solidity ^0.8.20;

library DoubleQueueModified {
    error Empty();

    error OutOfBounds();

    error QueueFull();

    /**
     * @dev Indices are 128 bits so begin and end are packed in a single storage slot for efficient access.
     *
     * Struct members have an underscore prefix indicating that they are "private" and should not be read or written to
     * directly. Use the functions provided below instead. Modifying the struct manually may violate assumptions and
     * lead to unexpected behavior.
     *
     * The first item is at data[begin] and the last item is at data[end - 1]. This range can wrap around.
     */
    struct BytesDeque {
        uint128 _begin;
        uint128 _end;
        mapping(uint128 index => bytes) _data;
    }

    /**
     * @dev Inserts an item at the end of the queue.
     *
     * Reverts with {QueueFull} if the queue is full.
     */
    function pushBack(BytesDeque storage deque, bytes memory value) internal {
        unchecked {
            uint128 backIndex = deque._end;
            if (backIndex + 1 == deque._begin) revert QueueFull();
            deque._data[backIndex] = value;
            deque._end = backIndex + 1;
        }
    }

    /**
     * @dev Inserts an item at the beginning of the queue.
     *
     * Reverts with {QueueFull} if the queue is full.
     */
    function pushFront(BytesDeque storage deque, bytes memory value) internal {
        unchecked {
            uint128 frontIndex = deque._begin - 1;
            if (frontIndex == deque._end) revert QueueFull();
            deque._data[frontIndex] = value;
            deque._begin = frontIndex;
        }
    }

    /**
     * @dev Removes the item at the beginning of the queue and returns it.
     *
     * Reverts with {Empty} if the queue is empty.
     */
    function popFront(BytesDeque storage deque) internal returns (bytes memory value) {
        unchecked {
            uint128 frontIndex = deque._begin;
            if (frontIndex == deque._end) revert Empty();
            value = deque._data[frontIndex];
            delete deque._data[frontIndex];
            deque._begin = frontIndex + 1;
        }
    }

    /**
     * @dev Removes the item at the end of the queue and returns it.
     *
     * Reverts with {Empty} if the queue is empty.
     */
    function popBack(BytesDeque storage deque) internal returns (bytes memory value) {
        unchecked {
            uint128 backIndex = deque._end;
            if (backIndex == deque._begin) revert Empty();
            --backIndex;
            value = deque._data[backIndex];
            delete deque._data[backIndex];
            deque._end = backIndex;
        }
    }

    /**
     * @dev Returns the item at the beginning of the queue.
     *
     * Reverts with {Empty} if the queue is empty.
     */
    function front(BytesDeque storage deque) internal view returns (bytes memory value) {
        if (empty(deque)) revert Empty();
        return deque._data[deque._begin];
    }

    /**
     * @dev Return the item at a position in the queue given by `index`, with the first item at 0 and last item at
     * `length(deque) - 1`.
     *
     * Reverts with {OutOfBounds} if the index is out of bounds.
     */
    function at(BytesDeque storage deque, uint256 index) internal view returns (bytes memory value) {
        if (index >= length(deque)) revert OutOfBounds();
        unchecked {
            return deque._data[deque._begin + uint128(index)];
        }
    }

    /**
     * @dev Resets the queue back to being empty.
     *
     * NOTE: The current items are left behind in storage. This does not affect the functioning of the queue, but misses
     * out on potential gas refunds.
     */
    function clear(BytesDeque storage deque) internal {
        deque._begin = 0;
        deque._end = 0;
    }

    /**
     * @dev Returns the number of items in the queue.
     */
    function length(BytesDeque storage deque) internal view returns (uint256) {
        unchecked {
            return uint256(deque._end - deque._begin);
        }
    }

    /**
     * @dev Returns true if the queue is empty.
     */
    function empty(BytesDeque storage deque) internal view returns (bool) {
        return deque._end == deque._begin;
    }
}
